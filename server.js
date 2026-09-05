const express = require('express');
const http = require('http');
const compression = require('compression');
const { Server } = require('socket.io');
const db = require('./database');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(compression());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'), (err) => {
        if (err) res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
});

app.get('/ping', (req, res) => res.status(200).send('OK'));

// Inicializar tabla de convenios
(async function initDB() {
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS convenios_facciones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                faccion TEXT UNIQUE NOT NULL,
                porcentaje INTEGER NOT NULL,
                usuario_nombre TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
    } catch (e) {
        console.error("Error iniciando tabla convenios:", e.message);
    }
})();

const onlineSockets = new Map();
io.on('connection', (socket) => {
    socket.on('user_connected', (userData) => {
        if (userData && userData.id) {
            onlineSockets.set(socket.id, {
                id: Number(userData.id),
                nombre: userData.nombre,
                usuario: userData.usuario,
                rol: userData.rol,
                comision_porcentaje: userData.comision_porcentaje
            });
            emitirUsuariosOnline();
        }
    });

    socket.on('disconnect', () => {
        if (onlineSockets.has(socket.id)) {
            onlineSockets.delete(socket.id);
            emitirUsuariosOnline();
        }
    });
});

function emitirUsuariosOnline() {
    const mapaUnicos = new Map();
    for (const u of onlineSockets.values()) mapaUnicos.set(u.id, u);
    io.emit('online_users_update', Array.from(mapaUnicos.values()));
}

function notificarCambioGlobal(evento, data = {}) {
    io.emit('db_update', { evento, ...data });
}

// CONVENIOS DE FACCIONES
app.get('/api/convenios', async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM convenios_facciones ORDER BY faccion ASC");
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/convenios', async (req, res) => {
    const { faccion, porcentaje, usuario_nombre } = req.body;
    if (!faccion || isNaN(porcentaje) || porcentaje <= 0) {
        return res.status(400).json({ error: "Datos del convenio inválidos." });
    }

    try {
        await db.execute({
            sql: "INSERT OR REPLACE INTO convenios_facciones (faccion, porcentaje, usuario_nombre) VALUES (?, ?, ?)",
            args: [faccion.toUpperCase().trim(), Number(porcentaje), usuario_nombre || 'Admin']
        });
        notificarCambioGlobal('convenios_actualizados');
        res.json({ message: "Convenio registrado." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/convenios/:id', async (req, res) => {
    try {
        await db.execute({ sql: "DELETE FROM convenios_facciones WHERE id = ?", args: [req.params.id] });
        notificarCambioGlobal('convenios_actualizados');
        res.json({ message: "Convenio eliminado." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// REGISTRO & LOGIN
app.post('/api/register', async (req, res) => {
    const { nombre, usuario, password } = req.body;
    if (!nombre || !usuario || !password) return res.status(400).json({ error: "Faltan campos por llenar." });

    try {
        const checkUser = await db.execute("SELECT COUNT(*) as total FROM usuarios");
        const esPrimerUsuario = checkUser.rows[0].total === 0;
        const rolInicial = esPrimerUsuario ? 'jefe' : 'empleado';
        const comisionInicial = esPrimerUsuario ? 0 : 30;

        const sql = `INSERT INTO usuarios (nombre, usuario, password, comision_porcentaje, rol) VALUES (?, ?, ?, ?, ?)`;
        const result = await db.execute({
            sql,
            args: [nombre, usuario.trim().toLowerCase(), password, comisionInicial, rolInicial]
        });

        notificarCambioGlobal('nuevo_usuario');
        res.json({ id: Number(result.lastInsertRowid), nombre, usuario, comision_porcentaje: comisionInicial, rol: rolInicial });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/login', async (req, res) => {
    const { usuario, password } = req.body;
    try {
        const sql = `SELECT id, nombre, usuario, COALESCE(rol, 'empleado') as rol, COALESCE(comision_porcentaje, 30) as comision_porcentaje FROM usuarios WHERE usuario = ? AND password = ?`;
        const result = await db.execute({ sql, args: [(usuario || '').trim().toLowerCase(), password] });
        if (result.rows.length === 0) return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// REGISTRAR FACTURA (RESPETANDO PRECIO TOTAL DE COMBOS Y PROTECCIÓN DE $500K EN V12)
app.post('/api/facturas', async (req, res) => {
    const { usuario_id, cliente, items, descuento_porcentaje, es_precio_fabrica } = req.body;
    if (!usuario_id) return res.status(400).json({ error: "Inicia sesión primero." });
    if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "No hay productos en la orden." });

    try {
        const userRes = await db.execute({ sql: "SELECT nombre, COALESCE(rol, 'empleado') as rol, COALESCE(comision_porcentaje, 30) as comision FROM usuarios WHERE id = ?", args: [usuario_id] });
        if (userRes.rows.length === 0) return res.status(400).json({ error: "Usuario no encontrado." });
        const user = userRes.rows[0];

        const aplicarFabrica = es_precio_fabrica && (user.rol === 'admin' || user.rol === 'jefe');
        const pctDescuento = aplicarFabrica ? 0 : Math.max(0, Math.min(100, Number(descuento_porcentaje) || 0));

        let v8Necesarios = 0;
        let v12Necesarios = 0;

        items.forEach(item => {
            if (item.id === 8 || item.id === 18 || item.id === 19) v8Necesarios += item.cantidad;
            if (item.id === 7 || item.id === 20 || item.id === 21) v12Necesarios += item.cantidad;
        });

        const estadoRes = await db.execute("SELECT stock_v8, stock_v12 FROM taller_estado WHERE id = 1");
        const estado = estadoRes.rows[0] || { stock_v8: 0, stock_v12: 0 };

        if (v12Necesarios > 0 && estado.stock_v12 < v12Necesarios) {
            return res.status(400).json({ error: `Almacén insuficiente: Se requieren ${v12Necesarios} Motor(es) V12 y solo hay ${estado.stock_v12} en stock.` });
        }

        let total_cliente = 0;
        let coste_fabrica_total = 0;
        let subtotal_bruto = 0;

        const itemsCalculados = items.map(item => {
            const precioBase = aplicarFabrica ? item.costo : item.venta;
            const subtotalLinea = precioBase * item.cantidad;
            coste_fabrica_total += item.costo * item.cantidad;
            subtotal_bruto += subtotalLinea;

            let descuentoLinea = 0;
            if (!aplicarFabrica && pctDescuento > 0) {
                if (item.id === 7) {
                    descuentoLinea = 0; // Motor V12 individual: $500K protegido
                } else if (item.tieneV12Fijo) {
                    const excedente = Math.max(0, precioBase - 500000);
                    descuentoLinea = (excedente * item.cantidad) * (pctDescuento / 100);
                } else {
                    descuentoLinea = subtotalLinea * (pctDescuento / 100);
                }
            }

            const totalFinalLinea = subtotalLinea - descuentoLinea;
            total_cliente += totalFinalLinea;

            return {
                ...item,
                precioCobrado: precioBase,
                subtotalLinea,
                descuentoMontoLinea: descuentoLinea,
                totalFinalLinea
            };
        });

        const ganancia_neta = total_cliente - coste_fabrica_total;
        const pctComision = user.comision / 100;
        const comision_empleado = ganancia_neta > 0 ? ganancia_neta * pctComision : 0;
        const fechaLocalMx = new Date().toLocaleString('sv', { timeZone: 'America/Mexico_City' }).replace('T', ' ');

        const insertRes = await db.execute({
            sql: `INSERT INTO facturas (usuario_id, cliente, total_cliente, coste_fabrica_total, ganancia_neta, comision_empleado, descuento_porcentaje, items_json, fecha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [usuario_id, cliente || 'Cliente General', total_cliente, coste_fabrica_total, ganancia_neta, comision_empleado, pctDescuento, JSON.stringify(itemsCalculados), fechaLocalMx]
        });

        const facturaId = Number(insertRes.lastInsertRowid);

        if (v8Necesarios > 0 || v12Necesarios > 0) {
            const descuentoV8 = Math.min(estado.stock_v8, v8Necesarios);
            await db.execute({
                sql: "UPDATE taller_estado SET stock_v8 = stock_v8 - ?, stock_v12 = stock_v12 - ? WHERE id = 1",
                args: [descuentoV8, v12Necesarios]
            });
        }

        notificarCambioGlobal('nueva_factura', {
            usuario_nombre: user.nombre,
            cliente: cliente || 'Cliente General',
            total: total_cliente,
            items: itemsCalculados
        });

        res.json({
            id: facturaId,
            subtotal: subtotal_bruto,
            total: total_cliente,
            comision: comision_empleado,
            porcentaje_aplicado: user.comision
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// HISTORIAL PERSONAL
app.get('/api/mis-facturas/:usuario_id', async (req, res) => {
    try {
        const result = await db.execute({
            sql: "SELECT * FROM facturas WHERE usuario_id = ? ORDER BY fecha DESC LIMIT 60",
            args: [req.params.usuario_id]
        });
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// HISTORIAL ADMIN
app.get('/api/admin/todas-facturas', async (req, res) => {
    try {
        const sql = `
            SELECT f.*, u.nombre as trabajador_nombre, u.usuario as trabajador_usuario 
            FROM facturas f 
            JOIN usuarios u ON f.usuario_id = u.id 
            ORDER BY f.fecha DESC LIMIT 80
        `;
        const result = await db.execute(sql);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// TOP
app.get('/api/top-trabajadores', async (req, res) => {
    try {
        const sql = `
            SELECT u.id, u.nombre, u.usuario, COALESCE(u.rol, 'empleado') as rol, COALESCE(u.comision_porcentaje, 30) as comision_porcentaje,
                   COUNT(f.id) as total_facturas,
                   COALESCE(SUM(f.total_cliente), 0) as total_vendido,
                   COALESCE(SUM(f.ganancia_neta), 0) as ganancia_generada,
                   COALESCE(SUM(f.comision_empleado), 0) as comision_ganada
            FROM usuarios u
            LEFT JOIN facturas f ON u.id = f.usuario_id
            GROUP BY u.id
            ORDER BY ganancia_generada DESC
        `;
        const result = await db.execute(sql);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ALMACÉN
app.get('/api/almacen/estado', async (req, res) => {
    try {
        const estadoRes = await db.execute("SELECT * FROM taller_estado WHERE id = 1");
        const movsRes = await db.execute("SELECT * FROM movimientos_capital ORDER BY fecha DESC LIMIT 30");
        res.json({ estado: estadoRes.rows[0] || { capital: 0, stock_v8: 0, stock_v12: 0 }, movimientos: movsRes.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));