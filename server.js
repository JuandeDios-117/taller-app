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

// Inicialización de tablas complementarias
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
    } catch (e) {}

    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS canjes_tienda (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                usuario_id INTEGER NOT NULL,
                trabajador_nombre TEXT NOT NULL,
                item_nombre TEXT NOT NULL,
                puntos_gastados INTEGER NOT NULL,
                estado TEXT DEFAULT 'pendiente',
                fecha DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
    } catch (e) {}

    try { await db.execute("ALTER TABLE usuarios ADD COLUMN puntos_saldo INTEGER DEFAULT 0"); } catch (e) {}
    try { await db.execute("ALTER TABLE usuarios ADD COLUMN xp_historica INTEGER DEFAULT 0"); } catch (e) {}
    try { await db.execute("ALTER TABLE usuarios ADD COLUMN medallas_json TEXT DEFAULT '{}'"); } catch (e) {}
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

// CONVENIOS
app.get('/api/convenios', async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM convenios_facciones ORDER BY faccion ASC");
        res.json(result.rows || []);
    } catch (err) {
        res.json([]);
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

// TIENDA, CANJES Y PUNTOS
app.get('/api/tienda/canjes', async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM canjes_tienda ORDER BY fecha DESC LIMIT 60");
        res.json(result.rows || []);
    } catch (err) {
        res.json([]);
    }
});

app.post('/api/tienda/canjear', async (req, res) => {
    const { usuario_id, item_nombre, costo_puntos } = req.body;
    const pts = parseInt(costo_puntos);
    if (!usuario_id || isNaN(pts) || pts <= 0) return res.status(400).json({ error: "Datos de canje inválidos." });

    try {
        const userRes = await db.execute({ sql: "SELECT nombre FROM usuarios WHERE id = ?", args: [usuario_id] });
        if (!userRes.rows || userRes.rows.length === 0) return res.status(404).json({ error: "Usuario no encontrado." });
        const user = userRes.rows[0];

        try {
            await db.execute({ sql: "UPDATE usuarios SET puntos_saldo = COALESCE(puntos_saldo, 0) - ? WHERE id = ?", args: [pts, usuario_id] });
        } catch(e) {}

        await db.execute({
            sql: "INSERT INTO canjes_tienda (usuario_id, trabajador_nombre, item_nombre, puntos_gastados, estado) VALUES (?, ?, ?, ?, 'pendiente')",
            args: [usuario_id, user.nombre, item_nombre, pts]
        });

        notificarCambioGlobal('canje_realizado');
        res.json({ message: `¡Canje registrado! Se te entregará tu ${item_nombre} en el juego.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/tienda/canjes/:id/entregar', async (req, res) => {
    try {
        await db.execute({ sql: "UPDATE canjes_tienda SET estado = 'entregado' WHERE id = ?", args: [req.params.id] });
        notificarCambioGlobal('canje_actualizado');
        res.json({ message: "Canje marcado como entregado in-game." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tienda/transferir-puntos', async (req, res) => {
    const { emisor_id, receptor_id, puntos } = req.body;
    const pts = parseInt(puntos);
    if (!emisor_id || !receptor_id || isNaN(pts) || pts <= 0) return res.status(400).json({ error: "Datos de transferencia inválidos." });
    if (emisor_id === receptor_id) return res.status(400).json({ error: "No puedes transferirte puntos a ti mismo." });

    try {
        const receptorRes = await db.execute({ sql: "SELECT nombre FROM usuarios WHERE id = ?", args: [receptor_id] });
        if (!receptorRes.rows || receptorRes.rows.length === 0) return res.status(404).json({ error: "Receptor no encontrado." });

        await db.execute({ sql: "UPDATE usuarios SET puntos_saldo = COALESCE(puntos_saldo, 0) - ? WHERE id = ?", args: [pts, emisor_id] });
        await db.execute({ sql: "UPDATE usuarios SET puntos_saldo = COALESCE(puntos_saldo, 0) + ? WHERE id = ?", args: [pts, receptor_id] });

        notificarCambioGlobal('puntos_transferidos');
        res.json({ message: `Se transfirieron ${pts} Puntos a ${receptorRes.rows[0].nombre}.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tienda/bono-ruleta', async (req, res) => {
    const { usuario_id, puntos } = req.body;
    const pts = parseInt(puntos);
    if (!usuario_id || isNaN(pts) || pts < 0) return res.status(400).json({ error: "Puntos inválidos." });

    try {
        await db.execute({ sql: "UPDATE usuarios SET puntos_saldo = COALESCE(puntos_saldo, 0) + ? WHERE id = ?", args: [pts, usuario_id] });
        notificarCambioGlobal('ruleta_girada');
        res.json({ message: "Bono acreditado correctamente." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// AÑADIR / AJUSTAR PUNTOS MANUALMENTE (DESDE PANEL ADMIN)
app.post('/api/admin/ajustar-puntos', async (req, res) => {
    const { usuario_id, puntos, operacion } = req.body;
    const pts = parseInt(puntos);
    if (!usuario_id || isNaN(pts) || pts <= 0) return res.status(400).json({ error: "Monto de puntos inválido." });

    try {
        const factor = operacion === 'restar' ? -pts : pts;
        await db.execute({
            sql: "UPDATE usuarios SET puntos_saldo = COALESCE(puntos_saldo, 0) + ? WHERE id = ?",
            args: [factor, usuario_id]
        });
        notificarCambioGlobal('puntos_actualizados');
        res.json({ message: `Puntos actualizados (${operacion === 'restar' ? '-' : '+'}${pts} Pts).` });
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

        const sql = `INSERT INTO usuarios (nombre, usuario, password, comision_porcentaje, rol, puntos_saldo, xp_historica) VALUES (?, ?, ?, ?, ?, 0, 0)`;
        const result = await db.execute({
            sql,
            args: [nombre, usuario.trim().toLowerCase(), password, comisionInicial, rolInicial]
        });

        notificarCambioGlobal('nuevo_usuario');
        res.json({ id: Number(result.lastInsertRowid), nombre, usuario, comision_porcentaje: comisionInicial, rol: rolInicial, puntos_saldo: 0 });
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: "El nombre de usuario ya está registrado." });
        }
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/login', async (req, res) => {
    const { usuario, password } = req.body;
    const userClean = (usuario || '').trim().toLowerCase();

    try {
        const sql = `SELECT id, nombre, usuario, COALESCE(rol, 'empleado') as rol, COALESCE(comision_porcentaje, 30) as comision_porcentaje, COALESCE(puntos_saldo, 0) as puntos_saldo, COALESCE(xp_historica, 0) as xp_historica FROM usuarios WHERE usuario = ? AND password = ?`;
        const result = await db.execute({ sql, args: [userClean, password] });
        
        if (!result.rows || result.rows.length === 0) return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ALMACÉN
app.get('/api/almacen/estado', async (req, res) => {
    try {
        const estadoRes = await db.execute("SELECT * FROM taller_estado WHERE id = 1");
        const movsRes = await db.execute("SELECT * FROM movimientos_capital ORDER BY fecha DESC LIMIT 30");
        res.json({ estado: (estadoRes.rows && estadoRes.rows[0]) || { capital: 0, stock_v8: 0, stock_v12: 0 }, movimientos: movsRes.rows || [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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

app.post('/api/almacen/comprar-motor', async (req, res) => {
    const { tipo_motor, cantidad, usuario_nombre } = req.body;
    const cant = parseInt(cantidad);
    if (isNaN(cant) || cant <= 0) return res.status(400).json({ error: "Cantidad inválida." });

    const costoUnitario = tipo_motor === 'v12' ? 300000 : 40000;
    const costoTotal = costoUnitario * cant;

    try {
        const estadoRes = await db.execute("SELECT capital FROM taller_estado WHERE id = 1");
        const estado = estadoRes.rows && estadoRes.rows[0];

        if (!estado || estado.capital < costoTotal) {
            return res.status(400).json({ error: `Capital insuficiente. Se requieren $${costoTotal.toLocaleString()} y dispones de $${(estado ? estado.capital : 0).toLocaleString()}` });
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

// LISTA DE USUARIOS
app.get('/api/usuarios', async (req, res) => {
    try {
        const result = await db.execute("SELECT id, nombre, usuario, COALESCE(rol, 'empleado') as rol, COALESCE(comision_porcentaje, 30) as comision_porcentaje, COALESCE(created_at, CURRENT_TIMESTAMP) as created_at FROM usuarios ORDER BY id ASC");
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/usuarios/modificar', async (req, res) => {
    const { usuario_id, comision_porcentaje, rol } = req.body;
    try {
        await db.execute({
            sql: "UPDATE usuarios SET comision_porcentaje = ?, rol = ? WHERE id = ?",
            args: [comision_porcentaje, rol, usuario_id]
        });
        notificarCambioGlobal('usuario_modificado', { usuario_id: Number(usuario_id), comision_porcentaje, rol });
        res.json({ message: "Usuario actualizado." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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

app.put('/api/facturas/:id/transferir', async (req, res) => {
    const factura_id = req.params.id;
    const { nuevo_usuario_id } = req.body;

    try {
        const userRes = await db.execute({ sql: "SELECT COALESCE(comision_porcentaje, 30) as comision FROM usuarios WHERE id = ?", args: [nuevo_usuario_id] });
        if (!userRes.rows || userRes.rows.length === 0) return res.status(404).json({ error: "El trabajador destino no existe." });
        const pctComision = userRes.rows[0].comision / 100;

        const factRes = await db.execute({ sql: "SELECT ganancia_neta FROM facturas WHERE id = ?", args: [factura_id] });
        if (!factRes.rows || factRes.rows.length === 0) return res.status(404).json({ error: "La factura no existe." });
        
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

// REINICIAR SEMANA (CONSERVA XP, NIVELES Y MEDALLAS)
app.post('/api/admin/reiniciar-semana', async (req, res) => {
    const { usuario_nombre } = req.body;
    try {
        try {
            await db.execute(`
                UPDATE usuarios 
                SET xp_historica = COALESCE(xp_historica, 0) + (
                    SELECT COALESCE(SUM(f.total_cliente), 0) FROM facturas f WHERE f.usuario_id = usuarios.id
                )
            `);
        } catch(e) {}

        await db.execute("DELETE FROM facturas");
        await db.execute({
            sql: "INSERT INTO movimientos_capital (tipo, descripcion, monto, usuario_nombre) VALUES ('corte_semanal', 'Reinicio semanal: facturas liquidadas. XP, niveles y medallas conservados.', 0, ?)",
            args: [usuario_nombre || 'Admin']
        });
        notificarCambioGlobal('reinicio_semana');
        res.json({ message: "Semana reiniciada correctamente. Los niveles y medallas han sido preservados." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// REGISTRAR FACTURA
app.post('/api/facturas', async (req, res) => {
    const { usuario_id, cliente, items, descuento_porcentaje, es_precio_fabrica } = req.body;
    if (!usuario_id) return res.status(400).json({ error: "Debes iniciar sesión primero." });
    if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "No hay productos en la orden." });

    try {
        const userRes = await db.execute({ sql: "SELECT nombre, COALESCE(rol, 'empleado') as rol, COALESCE(comision_porcentaje, 30) as comision FROM usuarios WHERE id = ?", args: [usuario_id] });
        if (!userRes.rows || userRes.rows.length === 0) return res.status(400).json({ error: "Usuario no encontrado." });
        const user = userRes.rows[0];

        const aplicarFabrica = es_precio_fabrica && (user.rol === 'admin' || user.rol === 'jefe');
        const pctDescuentoGeneral = aplicarFabrica ? 0 : Math.max(0, Math.min(100, Number(descuento_porcentaje) || 0));

        let v8Necesarios = 0;
        let v12Necesarios = 0;

        items.forEach(item => {
            if (item.id === 8) v8Necesarios += item.cantidad;
            if (item.id === 7) v12Necesarios += item.cantidad;
        });

        const estadoRes = await db.execute("SELECT stock_v8, stock_v12 FROM taller_estado WHERE id = 1");
        const estado = (estadoRes.rows && estadoRes.rows[0]) || { stock_v8: 0, stock_v12: 0 };

        if (v12Necesarios > 0 && estado.stock_v12 < v12Necesarios) {
            return res.status(400).json({ error: `Almacén insuficiente: Se requieren ${v12Necesarios} Motor(es) V12 y solo hay ${estado.stock_v12} en stock.` });
        }

        let total_cliente = 0;
        let coste_fabrica_total = 0;
        let subtotal_bruto = 0;

        const itemsDetallados = items.map(item => {
            const precioBase = aplicarFabrica ? item.costo : item.venta;
            const subtotalLinea = precioBase * item.cantidad;
            coste_fabrica_total += item.costo * item.cantidad;
            subtotal_bruto += subtotalLinea;

            const admiteDescuento = !aplicarFabrica && !item.noDescuento && item.id !== 7 && pctDescuentoGeneral > 0;
            const pctLinea = admiteDescuento ? pctDescuentoGeneral : 0;
            const descuentoMontoLinea = subtotalLinea * (pctLinea / 100);
            const totalFinalLinea = subtotalLinea - descuentoMontoLinea;

            total_cliente += totalFinalLinea;

            return {
                ...item,
                precioCobrado: precioBase,
                subtotalLinea,
                descuentoPorcentajeLinea: pctLinea,
                descuentoMontoLinea,
                totalFinalLinea
            };
        });

        const ganancia_neta = total_cliente - coste_fabrica_total;
        const pctComision = user.comision / 100;
        const comision_empleado = ganancia_neta > 0 ? ganancia_neta * pctComision : 0;
        const itemsJSON = JSON.stringify(itemsDetallados);
        const fechaLocalMx = new Date().toLocaleString('sv', { timeZone: 'America/Mexico_City' }).replace('T', ' ');

        const sql = `INSERT INTO facturas (usuario_id, cliente, total_cliente, coste_fabrica_total, ganancia_neta, comision_empleado, descuento_porcentaje, items_json, fecha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const insertRes = await db.execute({
            sql,
            args: [usuario_id, cliente || 'Cliente General', total_cliente, coste_fabrica_total, ganancia_neta, comision_empleado, pctDescuentoGeneral, itemsJSON, fechaLocalMx]
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

        notificarCambioGlobal('nueva_factura', { 
            usuario_nombre: user.nombre, 
            cliente: cliente || 'Cliente General', 
            total: total_cliente,
            items: itemsDetallados
        });

        res.json({
            id: facturaId,
            subtotal: subtotal_bruto,
            total: total_cliente,
            comision: comision_empleado,
            porcentaje_aplicado: user.comision,
            es_precio_fabrica: aplicarFabrica
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/mis-facturas/:usuario_id', async (req, res) => {
    try {
        const result = await db.execute({
            sql: "SELECT * FROM facturas WHERE usuario_id = ? ORDER BY fecha DESC LIMIT 60",
            args: [req.params.usuario_id]
        });
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// TOP TRABAJADORES (CON QUERY ROBUSTA)
app.get('/api/top-trabajadores', async (req, res) => {
    try {
        const sql = `
            SELECT u.id, u.nombre, u.usuario, 
                   COALESCE(u.rol, 'empleado') as rol, 
                   COALESCE(u.comision_porcentaje, 30) as comision_porcentaje, 
                   COALESCE(u.created_at, CURRENT_TIMESTAMP) as created_at,
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
        const rows = result.rows || [];

        for (let r of rows) {
            try {
                const s = await db.execute({ sql: "SELECT puntos_saldo, xp_historica FROM usuarios WHERE id = ?", args: [r.id] });
                if (s.rows && s.rows[0]) {
                    r.puntos_saldo = s.rows[0].puntos_saldo || 0;
                    r.xp_historica = s.rows[0].xp_historica || 0;
                }
            } catch(e) {
                r.puntos_saldo = 0;
                r.xp_historica = 0;
            }
        }

        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor ejecutándose en el puerto ${PORT}`));