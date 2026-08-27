const express = require('express');
const http = require('http');
const compression = require('compression');
const { Server } = require('socket.io');
const db = require('./database');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(compression());
app.use(express.json());
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'), (err) => {
        if (err) res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
});

app.get('/ping', (req, res) => res.status(200).send('OK'));

const onlineSockets = new Map();

io.on('connection', (socket) => {
    socket.on('user_connected', (userData) => {
        if (userData && userData.id) {
            onlineSockets.set(socket.id, {
                id: Number(userData.id),
                nombre: userData.nombre,
                usuario: userData.usuario,
                rol: userData.rol
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
    for (const u of onlineSockets.values()) {
        mapaUnicos.set(u.id, u);
    }
    io.emit('online_users_update', Array.from(mapaUnicos.values()));
}

function notificarCambioGlobal(evento, data = {}) {
    io.emit('db_update', { evento, ...data });
}

// 1. REGISTRO
app.post('/api/register', async (req, res) => {
    const { nombre, usuario, password } = req.body;
    if (!nombre || !usuario || !password) return res.status(400).json({ error: "Faltan campos por llenar." });

    try {
        const checkUser = await db.execute("SELECT COUNT(*) as total FROM usuarios");
        const esPrimerUsuario = checkUser.rows[0].total === 0;
        const rolInicial = esPrimerUsuario ? 'admin' : 'empleado';

        const sql = `INSERT INTO usuarios (nombre, usuario, password, comision_porcentaje, rol) VALUES (?, ?, ?, 30, ?)`;
        const result = await db.execute({
            sql: sql,
            args: [nombre, usuario.trim().toLowerCase(), password, rolInicial]
        });

        notificarCambioGlobal('nuevo_usuario');
        res.json({ id: Number(result.lastInsertRowid), nombre, usuario, comision_porcentaje: 30, rol: rolInicial });
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: "El nombre de usuario ya está registrado." });
        }
        res.status(500).json({ error: err.message });
    }
});

// 2. LOGIN (CONSULTA LIMPIA Y SEGURA)
app.post('/api/login', async (req, res) => {
    const { usuario, password } = req.body;
    const userClean = (usuario || '').trim().toLowerCase();

    try {
        const sql = `SELECT id, nombre, usuario, COALESCE(rol, 'empleado') as rol, COALESCE(comision_porcentaje, 30) as comision_porcentaje FROM usuarios WHERE usuario = ? AND password = ?`;
        const result = await db.execute({ sql, args: [userClean, password] });
        
        if (result.rows.length === 0) return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. ESTADO DE ALMACÉN Y CAPITAL
app.get('/api/almacen/estado', async (req, res) => {
    try {
        const estadoRes = await db.execute("SELECT * FROM taller_estado WHERE id = 1");
        const movsRes = await db.execute("SELECT * FROM movimientos_capital ORDER BY fecha DESC LIMIT 30");
        res.json({ estado: estadoRes.rows[0] || { capital: 0, stock_v8: 0, stock_v12: 0 }, movimientos: movsRes.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. INGRESAR CAPITAL
app.post('/api/almacen/ingresar-capital', async (req, res) => {
    const { monto, descripcion, usuario_nombre } = req.body;
    const montoNum = parseFloat(monto);
    if (isNaN(montoNum) || montoNum <= 0) return res.status(400).json({ error: "Ingresa un monto válido." });

    try {
        await db.execute({ sql: "UPDATE taller_estado SET capital = capital + ? WHERE id = 1", args: [montoNum] });
        await db.execute({
            sql: "INSERT INTO movimientos_capital (tipo, descripcion, monto, usuario_nombre) VALUES ('ingreso_capital', ?, ?, ?)",
            args: [descripcion || 'Inyección de Capital', montoNum, usuario_nombre || 'Admin']
        });
        notificarCambioGlobal('almacen_actualizado');
        res.json({ message: "Capital ingresado correctamente." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. COMPRAR MOTORES
app.post('/api/almacen/comprar-motor', async (req, res) => {
    const { tipo_motor, cantidad, usuario_nombre } = req.body;
    const cant = parseInt(cantidad);
    if (isNaN(cant) || cant <= 0) return res.status(400).json({ error: "Cantidad inválida." });

    const costoUnitario = tipo_motor === 'v12' ? 300000 : 40000;
    const costoTotal = costoUnitario * cant;

    try {
        const estadoRes = await db.execute("SELECT capital FROM taller_estado WHERE id = 1");
        const estado = estadoRes.rows[0];

        if (!estado || estado.capital < costoTotal) {
            return res.status(400).json({ error: `Capital insuficiente. Requiere $${costoTotal.toLocaleString()} y tienes $${(estado ? estado.capital : 0).toLocaleString()}` });
        }

        const columnaStock = tipo_motor === 'v12' ? 'stock_v12' : 'stock_v8';
        const desc = `Compra de ${cant}x Motor ${tipo_motor.toUpperCase()} a Fábrica`;

        await db.execute({ sql: `UPDATE taller_estado SET capital = capital - ?, ${columnaStock} = ${columnaStock} + ? WHERE id = 1`, args: [costoTotal, cant] });
        await db.execute({
            sql: "INSERT INTO movimientos_capital (tipo, descripcion, monto, usuario_nombre) VALUES (?, ?, ?, ?)",
            args: [`compra_${tipo_motor}`, desc, -costoTotal, usuario_nombre || 'Admin']
        });

        notificarCambioGlobal('almacen_actualizado');
        res.json({ message: `Comprados ${cant}x Motores ${tipo_motor.toUpperCase()} con éxito.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. AJUSTE MANUAL DE ALMACÉN
app.put('/api/almacen/ajuste-manual', async (req, res) => {
    const { capital, stock_v8, stock_v12, usuario_nombre } = req.body;
    const capNum = parseFloat(capital);
    const v8Num = parseInt(stock_v8);
    const v12Num = parseInt(stock_v12);

    if (isNaN(capNum) || isNaN(v8Num) || isNaN(v12Num) || capNum < 0 || v8Num < 0 || v12Num < 0) {
        return res.status(400).json({ error: "Valores numéricos inválidos." });
    }

    try {
        await db.execute({
            sql: "UPDATE taller_estado SET capital = ?, stock_v8 = ?, stock_v12 = ? WHERE id = 1",
            args: [capNum, v8Num, v12Num]
        });

        await db.execute({
            sql: "INSERT INTO movimientos_capital (tipo, descripcion, monto, usuario_nombre) VALUES ('ajuste_manual', ?, 0, ?)",
            args: [`Ajuste manual: Cap: $${capNum.toLocaleString()} | V8: ${v8Num} | V12: ${v12Num}`, usuario_nombre || 'Admin']
        });

        notificarCambioGlobal('almacen_actualizado');
        res.json({ message: "Inventario y capital actualizados." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7. LISTA DE USUARIOS
app.get('/api/usuarios', async (req, res) => {
    try {
        const result = await db.execute("SELECT id, nombre, usuario, COALESCE(rol, 'empleado') as rol, COALESCE(comision_porcentaje, 30) as comision_porcentaje, COALESCE(created_at, CURRENT_TIMESTAMP) as created_at FROM usuarios ORDER BY id ASC");
        res.json(result.rows);
    } catch (err) {
        // Compatibilidad por si created_at no responde
        try {
            const fallback = await db.execute("SELECT id, nombre, usuario, COALESCE(rol, 'empleado') as rol, COALESCE(comision_porcentaje, 30) as comision_porcentaje, CURRENT_TIMESTAMP as created_at FROM usuarios ORDER BY id ASC");
            res.json(fallback.rows);
        } catch (e2) {
            res.status(500).json({ error: err.message });
        }
    }
});

// 8. MODIFICAR USUARIO
app.put('/api/usuarios/modificar', async (req, res) => {
    const { usuario_id, comision_porcentaje, rol } = req.body;
    try {
        await db.execute({
            sql: "UPDATE usuarios SET comision_porcentaje = ?, rol = ? WHERE id = ?",
            args: [comision_porcentaje, rol, usuario_id]
        });
        notificarCambioGlobal('usuario_modificado', { usuario_id, comision_porcentaje, rol });
        res.json({ message: "Usuario actualizado." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 9. ELIMINAR USUARIO
app.delete('/api/usuarios/:id', async (req, res) => {
    const usuario_id = req.params.id;
    try {
        await db.execute({ sql: "DELETE FROM facturas WHERE usuario_id = ?", args: [usuario_id] });
        await db.execute({ sql: "DELETE FROM usuarios WHERE id = ?", args: [usuario_id] });
        notificarCambioGlobal('usuario_eliminado', { usuario_id: Number(usuario_id) });
        res.json({ message: "Cuenta eliminada correctamente." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 10. TRANSFERIR FACTURA
app.put('/api/facturas/:id/transferir', async (req, res) => {
    const factura_id = req.params.id;
    const { nuevo_usuario_id } = req.body;

    try {
        const userRes = await db.execute({ sql: "SELECT COALESCE(comision_porcentaje, 30) as comision FROM usuarios WHERE id = ?", args: [nuevo_usuario_id] });
        if (userRes.rows.length === 0) return res.status(404).json({ error: "El trabajador destino no existe." });
        const pctComision = userRes.rows[0].comision / 100;

        const factRes = await db.execute({ sql: "SELECT ganancia_neta FROM facturas WHERE id = ?", args: [factura_id] });
        if (factRes.rows.length === 0) return res.status(404).json({ error: "La factura no existe." });
        
        const ganancia = factRes.rows[0].ganancia_neta;
        const nuevaComision = ganancia > 0 ? ganancia * pctComision : 0;

        await db.execute({
            sql: "UPDATE facturas SET usuario_id = ?, comision_empleado = ? WHERE id = ?",
            args: [nuevo_usuario_id, nuevaComision, factura_id]
        });

        notificarCambioGlobal('factura_transferida');
        res.json({ message: "Factura transferida con éxito." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 11. ELIMINAR FACTURA
app.delete('/api/facturas/:id', async (req, res) => {
    const factura_id = req.params.id;
    try {
        await db.execute({ sql: "DELETE FROM facturas WHERE id = ?", args: [factura_id] });
        notificarCambioGlobal('factura_eliminada');
        res.json({ message: "Factura eliminada correctamente." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 12. REINICIAR SEMANA
app.post('/api/admin/reiniciar-semana', async (req, res) => {
    const { usuario_nombre } = req.body;
    try {
        await db.execute("DELETE FROM facturas");
        await db.execute({
            sql: "INSERT INTO movimientos_capital (tipo, descripcion, monto, usuario_nombre) VALUES ('corte_semanal', 'Reinicio de ciclo semanal: facturas liquidadas.', 0, ?)",
            args: [usuario_nombre || 'Admin']
        });
        notificarCambioGlobal('reinicio_semana');
        res.json({ message: "Semana reiniciada correctamente." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 13. REGISTRAR FACTURA
app.post('/api/facturas', async (req, res) => {
    const { usuario_id, cliente, items, descuento_porcentaje, es_precio_fabrica } = req.body;
    if (!usuario_id) return res.status(400).json({ error: "Debes iniciar sesión primero." });

    try {
        const userRes = await db.execute({ sql: "SELECT nombre, COALESCE(rol, 'empleado') as rol, COALESCE(comision_porcentaje, 30) as comision FROM usuarios WHERE id = ?", args: [usuario_id] });
        if (userRes.rows.length === 0) return res.status(400).json({ error: "Usuario no encontrado." });
        const user = userRes.rows[0];

        const aplicarFabrica = es_precio_fabrica && user.rol === 'admin';

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

        const pctComision = user.comision / 100;
        let subtotal_cliente = 0;
        let coste_fabrica_total = 0;

        items.forEach(item => {
            const precioCobrado = aplicarFabrica ? item.costo : item.venta;
            subtotal_cliente += precioCobrado * item.cantidad;
            coste_fabrica_total += item.costo * item.cantidad;
        });

        const descuento = aplicarFabrica ? 0 : subtotal_cliente * ((descuento_porcentaje || 0) / 100);
        const total_cliente = subtotal_cliente - descuento;
        const ganancia_neta = total_cliente - coste_fabrica_total;
        const comision_empleado = ganancia_neta > 0 ? ganancia_neta * pctComision : 0;
        const itemsJSON = JSON.stringify(items);

        const sql = `INSERT INTO facturas (usuario_id, cliente, total_cliente, coste_fabrica_total, ganancia_neta, comision_empleado, descuento_porcentaje, items_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        const insertRes = await db.execute({
            sql,
            args: [usuario_id, cliente || 'Cliente General', total_cliente, coste_fabrica_total, ganancia_neta, comision_empleado, aplicarFabrica ? 0 : (descuento_porcentaje || 0), itemsJSON]
        });

        const facturaId = Number(insertRes.lastInsertRowid);

        if (v8Necesarios > 0 || v12Necesarios > 0) {
            const descuentoV8 = Math.min(estado.stock_v8, v8Necesarios);
            await db.execute({ 
                sql: "UPDATE taller_estado SET stock_v8 = stock_v8 - ?, stock_v12 = stock_v12 - ? WHERE id = 1", 
                args: [descuentoV8, v12Necesarios] 
            });

            await db.execute({
                sql: "INSERT INTO movimientos_capital (tipo, descripcion, monto, usuario_nombre) VALUES ('despacho_almacen', ?, 0, ?)",
                args: [`Salida Orden #${facturaId} (Cliente: ${cliente}): ${v8Necesarios > 0 ? v8Necesarios + 'x V8 ' : ''}${v12Necesarios > 0 ? v12Necesarios + 'x V12' : ''}`, user.nombre]
            });
        }

        notificarCambioGlobal('nueva_factura');

        res.json({
            id: facturaId,
            subtotal: subtotal_cliente,
            total: total_cliente,
            comision: comision_empleado,
            porcentaje_aplicado: user.comision,
            es_precio_fabrica: aplicarFabrica
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 14. HISTORIAL PERSONAL
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

// 15. HISTORIAL GLOBAL
app.get('/api/admin/todas-facturas', async (req, res) => {
    try {
        const sql = `
            SELECT f.*, u.nombre as trabajador_nombre, u.usuario as trabajador_usuario 
            FROM facturas f 
            JOIN usuarios u ON f.usuario_id = u.id 
            ORDER BY f.fecha DESC
            LIMIT 80
        `;
        const result = await db.execute(sql);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 16. TOP TRABAJADORES
app.get('/api/top-trabajadores', async (req, res) => {
    try {
        const sql = `
            SELECT u.id, u.nombre, u.usuario, COALESCE(u.comision_porcentaje, 30) as comision_porcentaje, COALESCE(u.created_at, CURRENT_TIMESTAMP) as created_at,
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
        try {
            const fallback = await db.execute(`
                SELECT u.id, u.nombre, u.usuario, COALESCE(u.comision_porcentaje, 30) as comision_porcentaje, CURRENT_TIMESTAMP as created_at,
                       COUNT(f.id) as total_facturas,
                       COALESCE(SUM(f.total_cliente), 0) as total_vendido,
                       COALESCE(SUM(f.ganancia_neta), 0) as ganancia_generada,
                       COALESCE(SUM(f.comision_empleado), 0) as comision_ganada
                FROM usuarios u
                LEFT JOIN facturas f ON u.id = f.usuario_id
                GROUP BY u.id
                ORDER BY ganancia_generada DESC
            `);
            res.json(fallback.rows);
        } catch (e2) {
            res.status(500).json({ error: err.message });
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));