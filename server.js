const express = require('express');
const http = require('http');
const https = require('https');
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

// CONFIGURACIÓN OFICIAL DE RANGOS Y COMISIONES
const CATALOGO_RANGOS = {
    jefe:      { nombre: 'Jefe',              emoji: '👑', comision: 0,  rol_sistema: 'jefe',     orden: 8 },
    subjefe:   { nombre: 'Subjefe',           emoji: '🛡️', comision: 0,  rol_sistema: 'admin',    orden: 7 },
    encargado: { nombre: 'Encargado',         emoji: '👔', comision: 45, rol_sistema: 'empleado', orden: 6 },
    maestro:   { nombre: 'Mecánico Maestro',  emoji: '🛠️', comision: 43, rol_sistema: 'empleado', orden: 5 },
    experto:   { nombre: 'Mecánico Experto',  emoji: '⭐', comision: 40, rol_sistema: 'empleado', orden: 4 },
    senior:    { nombre: 'Mecánico Senior',   emoji: '🔩', comision: 37, rol_sistema: 'empleado', orden: 3 },
    mecanico:  { nombre: 'Mecánico',          emoji: '🔧', comision: 35, rol_sistema: 'empleado', orden: 2 },
    pruebas:   { nombre: 'En Pruebas',        emoji: '🔰', comision: 30, rol_sistema: 'empleado', orden: 1 },
    ciudadano: { nombre: 'Ciudadano',         emoji: '👤', comision: 0,  rol_sistema: 'baja',     orden: 0 }
};

function deducirClaveRango(rol, comision) {
    const com = Number(comision);
    if (rol === 'jefe' || com === -1) return 'jefe';
    if (com === 0) return 'subjefe';
    if (com >= 45) return 'encargado';
    if (com === 43) return 'maestro';
    if (com === 40) return 'experto';
    if (com === 37) return 'senior';
    if (com === 35) return 'mecanico';
    return 'pruebas';
}

// Función auxiliar para enviar payloads a un Webhook de Discord
function enviarWebhookDiscord(webhookUrl, payload) {
    return new Promise((resolve, reject) => {
        if (!webhookUrl || !webhookUrl.startsWith('http')) {
            return resolve({ enviado: false, razon: 'URL de Webhook no configurada o inválida.' });
        }
        try {
            const urlObj = new URL(webhookUrl);
            const dataString = JSON.stringify(payload);

            const options = {
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(dataString)
                }
            };

            const req = https.request(options, (res) => {
                let resBody = '';
                res.on('data', (chunk) => resBody += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ enviado: true });
                    } else {
                        resolve({ enviado: false, razon: `Discord respondió con código ${res.statusCode}: ${resBody}` });
                    }
                });
            });

            req.on('error', (e) => resolve({ enviado: false, razon: e.message }));
            req.write(dataString);
            req.end();
        } catch (err) {
            resolve({ enviado: false, razon: err.message });
        }
    });
}

// Formateador del Rol de Discord para mención <@&ID>
function formatearMencionRol(idRol, infoRango) {
    const limpio = (idRol || '').toString().replace(/[<@&>]/g, '').trim();
    if (limpio) {
        return `<@&${limpio}>`;
    }
    return `**${infoRango.emoji} ${infoRango.nombre}**`;
}

// Construye el Embed bonito para Discord con todos los movimientos aplicados
function construirPayloadAscensosDiscord(listaMovimientos, configMap, responsable) {
    const ascensosTexto = [];
    const degradacionesTexto = [];
    const bajasCiudadanoTexto = [];

    listaMovimientos.forEach(m => {
        const infoAnt = CATALOGO_RANGOS[m.rango_anterior_clave] || CATALOGO_RANGOS.pruebas;
        const infoNuevo = CATALOGO_RANGOS[m.nuevo_rango_clave] || CATALOGO_RANGOS.pruebas;

        const mencionAnt = formatearMencionRol(configMap[`rol_${m.rango_anterior_clave}`], infoAnt);
        const mencionNuevo = formatearMencionRol(configMap[`rol_${m.nuevo_rango_clave}`], infoNuevo);

        const discordTag = m.discord_id
            ? `<@${m.discord_id.replace(/[<@!>]/g, '').trim()}> (\`${m.nombre}\`)`
            : `**${m.nombre}** (\`@${m.usuario}\`)`;

        const notaMotivo = m.motivo ? `\n   └ 📝 *Motivo: ${m.motivo}*` : '';

        if (m.nuevo_rango_clave === 'ciudadano') {
            bajasCiudadanoTexto.push(
                `🔴 ${discordTag}\n   └ **Estado:** Baja del taller ➔ ${mencionNuevo} *(Cuenta retirada del sistema)*${notaMotivo}`
            );
        } else if (infoNuevo.orden >= infoAnt.orden) {
            ascensosTexto.push(
                `🟢 ${discordTag}\n   └ **Ascenso:** ${mencionAnt} ➔ ${mencionNuevo} (**${infoNuevo.comision}% Comisión**)${notaMotivo}`
            );
        } else {
            degradacionesTexto.push(
                `🟠 ${discordTag}\n   └ **Ajuste de Rango:** ${mencionAnt} ➔ ${mencionNuevo} (**${infoNuevo.comision}% Comisión**)${notaMotivo}`
            );
        }
    });

    const fields = [];

    if (ascensosTexto.length > 0) {
        fields.push({
            name: '🚀 ASCENSOS Y PROMOCIONES OFICIALES',
            value: ascensosTexto.join('\n\n').slice(0, 1024),
            inline: false
        });
    }

    if (degradacionesTexto.length > 0) {
        fields.push({
            name: '📉 AJUSTES DE RANGO / DEGRADACIONES',
            value: degradacionesTexto.join('\n\n').slice(0, 1024),
            inline: false
        });
    }

    if (bajasCiudadanoTexto.length > 0) {
        fields.push({
            name: '🚪 BAJAS DEL TALLER (CIUDADANO)',
            value: bajasCiudadanoTexto.join('\n\n').slice(0, 1024),
            inline: false
        });
    }

    const fechaMx = new Date().toLocaleDateString('es-MX', {
        timeZone: 'America/Mexico_City',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    return {
        username: "AutoExotic • Dirección General",
        content: "📢 **¡ACTUALIZACIÓN OFICIAL DE PLANTILLA Y CORTE SEMANAL AUTOEXOTIC!**",
        embeds: [
            {
                title: "🏆 REGISTRO OFICIAL DE ASCENSOS Y MOVIMIENTOS",
                description: `Se han aplicado los nuevos rangos, porcentajes de comisión y bajas correspondientes al cierre de semana.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                color: 0x06b6d4,
                fields: fields,
                footer: {
                    text: `Autorizado por: ${responsable || 'Dirección AutoExotic'} • ${fechaMx}`
                },
                timestamp: new Date().toISOString()
            }
        ]
    };
}

const onlineSockets = new Map();
io.on('connection', (socket) => {
    socket.on('user_connected', (userData) => {
        if (userData && userData.id) {
            onlineSockets.set(socket.id, {
                id: Number(userData.id),
                nombre: userData.nombre,
                usuario: userData.usuario,
                rol: userData.rol,
                comision_porcentaje: userData.comision_porcentaje,
                avatar: userData.avatar || null
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

// ==========================================
// ENDPOINTS DE CONFIGURACIÓN DISCORD Y ASCENSOS
// ==========================================

// Obtener configuración de Webhook e IDs de Roles de Discord
app.get('/api/discord/config', async (req, res) => {
    try {
        const result = await db.execute("SELECT clave, valor FROM discord_config");
        const config = {};
        result.rows.forEach(r => { config[r.clave] = r.valor || ''; });
        res.json({ config, catalogo_rangos: CATALOGO_RANGOS });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Guardar configuración de Webhook e IDs de Roles de Discord
app.put('/api/discord/config', async (req, res) => {
    const configData = req.body || {};
    try {
        for (const [clave, valor] of Object.entries(configData)) {
            await db.execute({
                sql: "INSERT OR REPLACE INTO discord_config (clave, valor) VALUES (?, ?)",
                args: [clave, (valor || '').toString().trim()]
            });
        }
        notificarCambioGlobal('discord_config_actualizada');
        res.json({ message: "Configuración de Discord y Roles guardada con éxito." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Obtener lista de ascensos/bajas programados para el corte
app.get('/api/ascensos-programados', async (req, res) => {
    try {
        const sql = `
            SELECT a.*, u.nombre, u.usuario, u.rol, u.comision_porcentaje, u.discord_id, u.avatar
            FROM ascensos_programados a
            JOIN usuarios u ON a.usuario_id = u.id
            ORDER BY a.fecha DESC
        `;
        const result = await db.execute(sql);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Programar un ascenso, cambio de rango o baja a Ciudadano
app.post('/api/ascensos-programados', async (req, res) => {
    const { usuario_id, nuevo_rango_clave, motivo, programado_por, discord_id } = req.body;
    if (!usuario_id || !nuevo_rango_clave || !CATALOGO_RANGOS[nuevo_rango_clave]) {
        return res.status(400).json({ error: "Selecciona un trabajador y un rango válido." });
    }

    try {
        const userRes = await db.execute({
            sql: "SELECT id, rol, comision_porcentaje FROM usuarios WHERE id = ?",
            args: [usuario_id]
        });
        if (userRes.rows.length === 0) return res.status(404).json({ error: "Trabajador no encontrado." });

        const u = userRes.rows[0];
        const rangoAnteriorClave = deducirClaveRango(u.rol, u.comision_porcentaje);

        // Si se proporcionó el Discord ID del usuario al programar, lo actualizamos en su ficha
        if (discord_id !== undefined) {
            await db.execute({
                sql: "UPDATE usuarios SET discord_id = ? WHERE id = ?",
                args: [discord_id.toString().replace(/[<@!>]/g, '').trim(), usuario_id]
            });
        }

        await db.execute({
            sql: `INSERT OR REPLACE INTO ascensos_programados 
                  (usuario_id, rango_anterior_clave, nuevo_rango_clave, motivo, programado_por, fecha) 
                  VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            args: [
                Number(usuario_id),
                rangoAnteriorClave,
                nuevo_rango_clave,
                (motivo || '').trim(),
                programado_por || 'Admin'
            ]
        });

        notificarCambioGlobal('ascensos_actualizados');
        res.json({ message: "Movimiento programado para el próximo corte semanal." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cancelar/Eliminar un ascenso programado antes del corte
app.delete('/api/ascensos-programados/:id', async (req, res) => {
    try {
        await db.execute({ sql: "DELETE FROM ascensos_programados WHERE id = ?", args: [req.params.id] });
        notificarCambioGlobal('ascensos_actualizados');
        res.json({ message: "Ascenso programado eliminado." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Función centralizada que aplica los ascensos programados, borra a los "Ciudadano" y manda el Webhook
async function procesarAscensosProgramados(responsable = 'Admin') {
    const ascRes = await db.execute(`
        SELECT a.*, u.nombre, u.usuario, u.rol, u.comision_porcentaje, u.discord_id
        FROM ascensos_programados a
        JOIN usuarios u ON a.usuario_id = u.id
        ORDER BY a.id ASC
    `);

    const programados = ascRes.rows;
    if (programados.length === 0) {
        return { aplicados: 0, eliminados: 0, webhook: { enviado: false, razon: 'No había ascensos programados.' } };
    }

    const cfgRes = await db.execute("SELECT clave, valor FROM discord_config");
    const configMap = {};
    cfgRes.rows.forEach(r => { configMap[r.clave] = r.valor || ''; });

    let aplicados = 0;
    let eliminados = 0;

    for (const item of programados) {
        const infoNuevo = CATALOGO_RANGOS[item.nuevo_rango_clave];
        if (!infoNuevo) continue;

        if (item.nuevo_rango_clave === 'ciudadano') {
            // Se le da de baja y se borra su cuenta y registros de la página
            await db.execute({ sql: "DELETE FROM facturas WHERE usuario_id = ?", args: [item.usuario_id] });
            await db.execute({ sql: "DELETE FROM pedidos_puntos WHERE usuario_id = ?", args: [item.usuario_id] });
            await db.execute({ sql: "DELETE FROM usuarios WHERE id = ?", args: [item.usuario_id] });
            notificarCambioGlobal('usuario_eliminado', { usuario_id: Number(item.usuario_id) });
            eliminados++;
        } else {
            // Conservamos permiso admin si ya lo tenía, salvo que suba a jefe
            let nuevoRolSistema = item.rol;
            if (item.nuevo_rango_clave === 'jefe') {
                nuevoRolSistema = 'jefe';
            } else if (item.nuevo_rango_clave === 'subjefe' && nuevoRolSistema === 'empleado') {
                nuevoRolSistema = 'admin';
            } else if (nuevoRolSistema === 'jefe' && item.nuevo_rango_clave !== 'jefe') {
                nuevoRolSistema = 'admin';
            }

            await db.execute({
                sql: "UPDATE usuarios SET comision_porcentaje = ?, rol = ? WHERE id = ?",
                args: [infoNuevo.comision, nuevoRolSistema, item.usuario_id]
            });

            notificarCambioGlobal('usuario_modificado', {
                usuario_id: Number(item.usuario_id),
                comision_porcentaje: infoNuevo.comision,
                rol: nuevoRolSistema
            });
            aplicados++;
        }
    }

    // Limpiar la cola de ascensos programados tras aplicarlos
    await db.execute("DELETE FROM ascensos_programados");

    // Construir y disparar el mensaje hacia Discord
    const payloadDiscord = construirPayloadAscensosDiscord(programados, configMap, responsable);
    const resultadoWebhook = await enviarWebhookDiscord(configMap.webhook_url, payloadDiscord);

    notificarCambioGlobal('ascensos_actualizados');
    notificarCambioGlobal('top_actualizado');

    return { aplicados, eliminados, webhook: resultadoWebhook };
}

// Botón opcional por si el Admin desea aplicar y publicar los ascensos sin reiniciar facturas
app.post('/api/ascensos-programados/aplicar-ahora', async (req, res) => {
    const { usuario_nombre } = req.body;
    try {
        const resultado = await procesarAscensosProgramados(usuario_nombre || 'Admin');
        res.json({
            message: `Se aplicaron ${resultado.aplicados} ascenso(s) y ${resultado.eliminados} baja(s) a Ciudadano.`,
            ...resultado
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// CONVENIOS DE FACCIONES
// ==========================================
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
    if (!faccion || isNaN(porcentaje) || porcentaje <= 0) return res.status(400).json({ error: "Datos del convenio inválidos." });

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

// 1. REGISTRO
app.post('/api/register', async (req, res) => {
    const { nombre, usuario, password } = req.body;
    if (!nombre || !usuario || !password) return res.status(400).json({ error: "Faltan campos por llenar." });

    try {
        const checkUser = await db.execute("SELECT COUNT(*) as total FROM usuarios");
        const esPrimerUsuario = checkUser.rows[0].total === 0;
        const rolInicial = esPrimerUsuario ? 'jefe' : 'empleado';
        const comisionInicial = esPrimerUsuario ? 0 : 30;

        const sql = `INSERT INTO usuarios (nombre, usuario, password, comision_porcentaje, rol, puntos) VALUES (?, ?, ?, ?, ?, 0)`;
        const result = await db.execute({
            sql,
            args: [nombre, usuario.trim().toLowerCase(), password, comisionInicial, rolInicial]
        });

        notificarCambioGlobal('nuevo_usuario');
        res.json({ id: Number(result.lastInsertRowid), nombre, usuario, comision_porcentaje: comisionInicial, rol: rolInicial, puntos: 0, avatar: null });
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) return res.status(400).json({ error: "El nombre de usuario ya está registrado." });
        res.status(500).json({ error: err.message });
    }
});

// 2. LOGIN
app.post('/api/login', async (req, res) => {
    const { usuario, password } = req.body;
    const userClean = (usuario || '').trim().toLowerCase();

    try {
        const sql = `SELECT id, nombre, usuario, COALESCE(rol, 'empleado') as rol, COALESCE(comision_porcentaje, 30) as comision_porcentaje, COALESCE(puntos, 0) as puntos, avatar, COALESCE(discord_id, '') as discord_id FROM usuarios WHERE usuario = ? AND password = ?`;
        const result = await db.execute({ sql, args: [userClean, password] });
        if (result.rows.length === 0) return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. ALMACÉN ESTADO
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

// 5. COMPRA DE MOTORES A FÁBRICA
app.post('/api/almacen/comprar-motor', async (req, res) => {
    const { tipo_motor, cantidad, usuario_nombre } = req.body;
    const cant = parseInt(cantidad);
    if (isNaN(cant) || cant <= 0) return res.status(400).json({ error: "Cantidad inválida." });

    const costoUnitario = tipo_motor === 'v12' ? 300000 : 40000;
    const costoTotal = costoUnitario * cant;

    try {
        const estadoRes = await db.execute("SELECT capital FROM taller_estado WHERE id = 1");
        const estado = estadoRes.rows[0];

        if (!estado || estado.capital < costoTotal) return res.status(400).json({ error: `Capital insuficiente. Se requieren $${costoTotal.toLocaleString()}` });

        const columnaStock = tipo_motor === 'v12' ? 'stock_v12' : 'stock_v8';
        const desc = `Compra de ${cant}x Motor ${tipo_motor.toUpperCase()} a Fábrica`;

        await db.execute({ sql: `UPDATE taller_estado SET capital = capital - ?, ${columnaStock} = ${columnaStock} + ? WHERE id = 1`, args: [costoTotal, cant] });
        await db.execute({ sql: "INSERT INTO movimientos_capital (tipo, descripcion, monto, usuario_nombre) VALUES (?, ?, ?, ?)", args: [`compra_${tipo_motor}`, desc, -costoTotal, usuario_nombre || 'Admin'] });

        notificarCambioGlobal('almacen_actualizado');
        res.json({ message: `Comprados ${cant}x Motores ${tipo_motor.toUpperCase()} con éxito.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. AJUSTE MANUAL ALMACÉN
app.put('/api/almacen/ajuste-manual', async (req, res) => {
    const { capital, stock_v8, stock_v12, usuario_nombre } = req.body;
    const capNum = parseFloat(capital); const v8Num = parseInt(stock_v8); const v12Num = parseInt(stock_v12);

    if (isNaN(capNum) || isNaN(v8Num) || isNaN(v12Num) || capNum < 0 || v8Num < 0 || v12Num < 0) return res.status(400).json({ error: "Valores numéricos inválidos." });

    try {
        await db.execute({ sql: "UPDATE taller_estado SET capital = ?, stock_v8 = ?, stock_v12 = ? WHERE id = 1", args: [capNum, v8Num, v12Num] });
        await db.execute({ sql: "INSERT INTO movimientos_capital (tipo, descripcion, monto, usuario_nombre) VALUES ('ajuste_manual', ?, 0, ?)", args: [`Ajuste manual: Cap: $${capNum.toLocaleString()} | V8: ${v8Num} | V12: ${v12Num}`, usuario_nombre || 'Admin'] });
        notificarCambioGlobal('almacen_actualizado');
        res.json({ message: "Inventario y capital actualizados." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7. LISTA DE USUARIOS
app.get('/api/usuarios', async (req, res) => {
    try {
        const result = await db.execute("SELECT id, nombre, usuario, COALESCE(rol, 'empleado') as rol, COALESCE(comision_porcentaje, 30) as comision_porcentaje, COALESCE(puntos, 0) as puntos, avatar, COALESCE(discord_id, '') as discord_id, COALESCE(created_at, CURRENT_TIMESTAMP) as created_at FROM usuarios ORDER BY id ASC");
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 8. MODIFICAR RANGO, PERMISOS, PUNTOS Y DISCORD_ID DE USUARIO
app.put('/api/usuarios/modificar', async (req, res) => {
    const { usuario_id, comision_porcentaje, rol, puntos, discord_id } = req.body;
    try {
        // Si seleccionaron "ciudadano" directamente en la tabla, eliminamos la cuenta
        if (rol === 'ciudadano' || Number(comision_porcentaje) === -99) {
            await db.execute({ sql: "DELETE FROM facturas WHERE usuario_id = ?", args: [usuario_id] });
            await db.execute({ sql: "DELETE FROM pedidos_puntos WHERE usuario_id = ?", args: [usuario_id] });
            await db.execute({ sql: "DELETE FROM ascensos_programados WHERE usuario_id = ?", args: [usuario_id] });
            await db.execute({ sql: "DELETE FROM usuarios WHERE id = ?", args: [usuario_id] });
            notificarCambioGlobal('usuario_eliminado', { usuario_id: Number(usuario_id) });
            notificarCambioGlobal('top_actualizado');
            return res.json({ message: "Usuario pasado a Ciudadano y eliminado de la página." });
        }

        await db.execute({
            sql: "UPDATE usuarios SET comision_porcentaje = ?, rol = ?, puntos = ?, discord_id = COALESCE(?, discord_id) WHERE id = ?",
            args: [
                comision_porcentaje,
                rol,
                Number(puntos) || 0,
                discord_id !== undefined ? discord_id.toString().replace(/[<@!>]/g, '').trim() : null,
                usuario_id
            ]
        });

        notificarCambioGlobal('usuario_modificado', {
            usuario_id: Number(usuario_id),
            comision_porcentaje,
            rol,
            puntos: Number(puntos) || 0
        });
        notificarCambioGlobal('top_actualizado');
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
        await db.execute({ sql: "DELETE FROM pedidos_puntos WHERE usuario_id = ?", args: [usuario_id] });
        await db.execute({ sql: "DELETE FROM ascensos_programados WHERE usuario_id = ?", args: [usuario_id] });
        await db.execute({ sql: "DELETE FROM usuarios WHERE id = ?", args: [usuario_id] });
        notificarCambioGlobal('usuario_eliminado', { usuario_id: Number(usuario_id) });
        notificarCambioGlobal('top_actualizado');
        res.json({ message: "Cuenta eliminada correctamente." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 10. TRANSFERIR FACTURA
app.put('/api/facturas/:id/transferir', async (req, res) => {
    const factura_id = req.params.id; const { nuevo_usuario_id } = req.body;
    try {
        const userRes = await db.execute({ sql: "SELECT COALESCE(comision_porcentaje, 30) as comision FROM usuarios WHERE id = ?", args: [nuevo_usuario_id] });
        if (userRes.rows.length === 0) return res.status(404).json({ error: "El trabajador destino no existe." });
        const pctComision = userRes.rows[0].comision / 100;
        const factRes = await db.execute({ sql: "SELECT ganancia_neta FROM facturas WHERE id = ?", args: [factura_id] });
        if (factRes.rows.length === 0) return res.status(404).json({ error: "La factura no existe." });
        
        const ganancia = factRes.rows[0].ganancia_neta; const nuevaComision = ganancia > 0 ? ganancia * pctComision : 0;
        await db.execute({ sql: "UPDATE facturas SET usuario_id = ?, comision_empleado = ? WHERE id = ?", args: [nuevo_usuario_id, nuevaComision, factura_id] });
        notificarCambioGlobal('factura_transferida'); notificarCambioGlobal('top_actualizado');
        res.json({ message: "Factura transferida con éxito." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 11. ELIMINAR FACTURA
app.delete('/api/facturas/:id', async (req, res) => {
    const factura_id = req.params.id;
    try {
        await db.execute({ sql: "DELETE FROM facturas WHERE id = ?", args: [factura_id] });
        notificarCambioGlobal('factura_eliminada'); notificarCambioGlobal('top_actualizado');
        res.json({ message: "Factura eliminada correctamente." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 12. REINICIAR SEMANA (Liquida facturas + Aplica Ascensos Programados + Borra Ciudadanos + Publica en Discord)
app.post('/api/admin/reiniciar-semana', async (req, res) => {
    const { usuario_nombre } = req.body;
    try {
        // 1. Borrar todas las facturas de la semana
        await db.execute("DELETE FROM facturas");

        // 2. Aplicar todos los ascensos programados y bajas a Ciudadano + Enviar Webhook a Discord
        const resultadoAscensos = await procesarAscensosProgramados(usuario_nombre || 'Admin');

        const detalleMov = `Reinicio semanal: facturas liquidadas. Ascensos aplicados: ${resultadoAscensos.aplicados}, Bajas (Ciudadano): ${resultadoAscensos.eliminados}.`;
        await db.execute({
            sql: "INSERT INTO movimientos_capital (tipo, descripcion, monto, usuario_nombre) VALUES ('corte_semanal', ?, 0, ?)",
            args: [detalleMov, usuario_nombre || 'Admin']
        });

        notificarCambioGlobal('reinicio_semana');
        notificarCambioGlobal('top_actualizado');

        res.json({
            message: "Semana reiniciada y ascensos aplicados correctamente.",
            ascensos: resultadoAscensos
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 13. REGISTRAR FACTURA
app.post('/api/facturas', async (req, res) => {
    const { usuario_id, cliente, items, descuento_porcentaje, es_precio_fabrica } = req.body;
    if (!usuario_id) return res.status(400).json({ error: "Debes iniciar sesión primero." });
    if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "No hay productos en la orden." });

    try {
        const userRes = await db.execute({ sql: "SELECT nombre, COALESCE(rol, 'empleado') as rol, COALESCE(comision_porcentaje, 30) as comision FROM usuarios WHERE id = ?", args: [usuario_id] });
        if (userRes.rows.length === 0) return res.status(400).json({ error: "Usuario no encontrado." });
        const user = userRes.rows[0];

        const aplicarFabrica = es_precio_fabrica && (user.rol === 'admin' || user.rol === 'jefe');
        const pctDescuentoGeneral = aplicarFabrica ? 0 : Math.max(0, Math.min(100, Number(descuento_porcentaje) || 0));

        let v8Necesarios = 0, v12Necesarios = 0;

        items.forEach(item => {
            if (item.id === 8) v8Necesarios += item.cantidad;
            if (item.id === 7) v12Necesarios += item.cantidad;
        });

        const estadoRes = await db.execute("SELECT stock_v8, stock_v12 FROM taller_estado WHERE id = 1");
        const estado = estadoRes.rows[0] || { stock_v8: 0, stock_v12: 0 };

        if (v12Necesarios > 0 && estado.stock_v12 < v12Necesarios) return res.status(400).json({ error: `Almacén insuficiente: Se requieren ${v12Necesarios} Motor(es) V12.` });

        let total_cliente = 0, coste_fabrica_total = 0, subtotal_bruto = 0;

        const itemsDetallados = items.map(item => {
            const precioBase = aplicarFabrica ? item.costo : item.venta; const subtotalLinea = precioBase * item.cantidad;
            coste_fabrica_total += item.costo * item.cantidad; subtotal_bruto += subtotalLinea;

            const admiteDescuento = !aplicarFabrica && !item.noDescuento && item.id !== 7 && pctDescuentoGeneral > 0;
            const pctLinea = admiteDescuento ? pctDescuentoGeneral : 0;
            const descuentoMontoLinea = subtotalLinea * (pctLinea / 100); const totalFinalLinea = subtotalLinea - descuentoMontoLinea;
            total_cliente += totalFinalLinea;

            return { ...item, precioCobrado: precioBase, subtotalLinea, descuentoPorcentajeLinea: pctLinea, descuentoMontoLinea, totalFinalLinea };
        });

        const ganancia_neta = total_cliente - coste_fabrica_total;
        const pctComision = user.comision / 100;
        const comision_empleado = ganancia_neta > 0 ? ganancia_neta * pctComision : 0;
        const itemsJSON = JSON.stringify(itemsDetallados);
        const fechaLocalMx = new Date().toLocaleString('sv', { timeZone: 'America/Mexico_City' }).replace('T', ' ');

        const sql = `INSERT INTO facturas (usuario_id, cliente, total_cliente, coste_fabrica_total, ganancia_neta, comision_empleado, descuento_porcentaje, items_json, fecha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const insertRes = await db.execute({
            sql, args: [usuario_id, cliente || 'Cliente General', total_cliente, coste_fabrica_total, ganancia_neta, comision_empleado, pctDescuentoGeneral, itemsJSON, fechaLocalMx]
        });

        const facturaId = Number(insertRes.lastInsertRowid);

        const puntosGanados = Math.floor(ganancia_neta / 50000) || 1;
        try { await db.execute({ sql: "UPDATE usuarios SET puntos = COALESCE(puntos, 0) + ? WHERE id = ?", args: [puntosGanados, usuario_id] }); } catch(e){}

        if (v8Necesarios > 0 || v12Necesarios > 0) {
            const descuentoV8 = Math.min(estado.stock_v8, v8Necesarios);
            await db.execute({ sql: "UPDATE taller_estado SET stock_v8 = stock_v8 - ?, stock_v12 = stock_v12 - ? WHERE id = 1", args: [descuentoV8, v12Necesarios] });
            await db.execute({ sql: "INSERT INTO movimientos_capital (tipo, descripcion, monto, usuario_nombre) VALUES ('despacho_almacen', ?, 0, ?)", args: [`Salida Orden #${facturaId} (Cliente: ${cliente}): ${v8Necesarios > 0 ? v8Necesarios + 'x V8 ' : ''}${v12Necesarios > 0 ? v12Necesarios + 'x V12' : ''}`, user.nombre] });
        }

        notificarCambioGlobal('nueva_factura', { usuario_nombre: user.nombre, cliente: cliente || 'Cliente General', total: total_cliente, items: itemsDetallados });
        notificarCambioGlobal('top_actualizado');

        res.json({ id: facturaId, subtotal: subtotal_bruto, total: total_cliente, comision: comision_empleado, porcentaje_aplicado: user.comision, puntos_ganados: puntosGanados, es_precio_fabrica: aplicarFabrica });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 14. HISTORIAL PERSONAL
app.get('/api/mis-facturas/:usuario_id', async (req, res) => {
    try {
        const result = await db.execute({ sql: "SELECT * FROM facturas WHERE usuario_id = ? ORDER BY fecha DESC LIMIT 60", args: [req.params.usuario_id] });
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 15. HISTORIAL GLOBAL
app.get('/api/admin/todas-facturas', async (req, res) => {
    try {
        const sql = `SELECT f.*, u.nombre as trabajador_nombre, u.usuario as trabajador_usuario, u.avatar as trabajador_avatar FROM facturas f JOIN usuarios u ON f.usuario_id = u.id ORDER BY f.fecha DESC LIMIT 80`;
        const result = await db.execute(sql);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 16. TOP TRABAJADORES
app.get('/api/top-trabajadores', async (req, res) => {
    try {
        const sql = `
            SELECT u.id, u.nombre, u.usuario, COALESCE(u.rol, 'empleado') as rol, COALESCE(u.comision_porcentaje, 30) as comision_porcentaje, 
                   COALESCE(u.puntos, 0) as puntos,
                   u.avatar, COALESCE(u.created_at, CURRENT_TIMESTAMP) as created_at,
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

// GESTIÓN DE TIENDA Y AVATARES
app.put('/api/usuarios/:id/avatar', async (req, res) => {
    try {
        await db.execute({ sql: "UPDATE usuarios SET avatar = ? WHERE id = ?", args: [req.body.avatar, req.params.id] });
        notificarCambioGlobal('avatar_actualizado');
        notificarCambioGlobal('top_actualizado');
        res.json({ message: "Avatar guardado globalmente." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/pedidos-puntos', async (req, res) => {
    try {
        const sql = `SELECT p.*, u.nombre as trabajador_nombre FROM pedidos_puntos p JOIN usuarios u ON p.usuario_id = u.id ORDER BY p.fecha DESC`;
        const result = await db.execute(sql);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pedidos-puntos', async (req, res) => {
    const { usuario_id, item_nombre, costo_puntos } = req.body;
    try {
        const userRes = await db.execute({ sql: "SELECT COALESCE(puntos, 0) as puntos FROM usuarios WHERE id = ?", args: [usuario_id] });
        const puntosActuales = userRes.rows[0]?.puntos || 0;
        
        if (puntosActuales < costo_puntos) return res.status(400).json({ error: "Puntos insuficientes." });
        
        await db.execute({ sql: "UPDATE usuarios SET puntos = puntos - ? WHERE id = ?", args: [costo_puntos, usuario_id] });
        await db.execute({ sql: "INSERT INTO pedidos_puntos (usuario_id, item_nombre, costo_puntos) VALUES (?, ?, ?)", args: [usuario_id, item_nombre, costo_puntos] });
        
        notificarCambioGlobal('pedido_puntos_creado');
        notificarCambioGlobal('top_actualizado');
        res.json({ message: "Pedido realizado con éxito." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/pedidos-puntos/:id/estado', async (req, res) => {
    const { estado } = req.body;
    try {
        if (estado === 'rechazado') {
            const pedidoRes = await db.execute({ sql: "SELECT usuario_id, costo_puntos FROM pedidos_puntos WHERE id = ?", args: [req.params.id] });
            if (pedidoRes.rows[0]) {
                await db.execute({ sql: "UPDATE usuarios SET puntos = puntos + ? WHERE id = ?", args: [pedidoRes.rows[0].costo_puntos, pedidoRes.rows[0].usuario_id] });
            }
        }
        await db.execute({ sql: "UPDATE pedidos_puntos SET estado = ? WHERE id = ?", args: [estado, req.params.id] });
        notificarCambioGlobal('pedido_puntos_actualizado');
        notificarCambioGlobal('top_actualizado');
        res.json({ message: `Pedido ${estado}.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor ejecutándose en el puerto ${PORT}`));