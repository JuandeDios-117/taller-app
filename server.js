const express = require('express');
const db = require('./database');
const path = require('path');

const app = express();
app.use(express.json());

// Servir archivos estáticos directamente desde la raíz
app.use(express.static(__dirname));

// Servir la página principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Inicializar tablas y columnas requeridas
db.serialize(() => {
    db.run(`ALTER TABLE usuarios ADD COLUMN rol TEXT DEFAULT 'empleado'`, () => {});
    db.run(`ALTER TABLE usuarios ADD COLUMN comision_porcentaje REAL DEFAULT 30`, () => {});
    db.run(`ALTER TABLE facturas ADD COLUMN cliente TEXT`, () => {});
    db.run(`ALTER TABLE facturas ADD COLUMN descuento_porcentaje REAL DEFAULT 0`, () => {});
    db.run(`ALTER TABLE facturas ADD COLUMN items_json TEXT`, () => {});

    // Tabla de Estado General (Capital y Stock)
    db.run(`CREATE TABLE IF NOT EXISTS taller_estado (
        id INTEGER PRIMARY KEY,
        capital REAL DEFAULT 0,
        stock_v8 INTEGER DEFAULT 0,
        stock_v12 INTEGER DEFAULT 0
    )`);

    // Registro inicial de almacén si no existe
    db.get("SELECT COUNT(*) as total FROM taller_estado", [], (err, row) => {
        if (row && row.total === 0) {
            db.run("INSERT INTO taller_estado (id, capital, stock_v8, stock_v12) VALUES (1, 0, 0, 0)");
        }
    });

    // Historial de Movimientos de Capital e Inventario
    db.run(`CREATE TABLE IF NOT EXISTS movimientos_capital (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo TEXT,
        descripcion TEXT,
        monto REAL,
        usuario_nombre TEXT,
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// 1. REGISTRO DE TRABAJADOR
app.post('/api/register', (req, res) => {
    const { nombre, usuario, password } = req.body;
    if (!nombre || !usuario || !password) return res.status(400).json({ error: "Faltan campos por llenar." });

    db.get("SELECT COUNT(*) as total FROM usuarios", [], (err, row) => {
        const esPrimerUsuario = row && row.total === 0;
        const rolInicial = esPrimerUsuario ? 'admin' : 'empleado';

        const sql = `INSERT INTO usuarios (nombre, usuario, password, comision_porcentaje, rol) VALUES (?, ?, ?, 30, ?)`;
        db.run(sql, [nombre, usuario.trim().toLowerCase(), password, rolInicial], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) return res.status(400).json({ error: "El nombre de usuario ya está registrado." });
                return res.status(500).json({ error: err.message });
            }
            res.json({ id: this.lastID, nombre, usuario, comision_porcentaje: 30, rol: rolInicial });
        });
    });
});

// 2. LOGIN
app.post('/api/login', (req, res) => {
    const { usuario, password } = req.body;
    const userClean = (usuario || '').trim().toLowerCase();

    const sql = `SELECT id, nombre, usuario, COALESCE(rol, 'empleado') as rol, COALESCE(comision_porcentaje, 30) as comision_porcentaje FROM usuarios WHERE usuario = ? AND password = ?`;
    db.get(sql, [userClean, password], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
        res.json(row);
    });
});

// 3. CONSULTAR ESTADO DE CAPITAL Y ALMACÉN
app.get('/api/almacen/estado', (req, res) => {
    db.get("SELECT * FROM taller_estado WHERE id = 1", [], (err, estado) => {
        if (err) return res.status(500).json({ error: err.message });
        db.all("SELECT * FROM movimientos_capital ORDER BY fecha DESC LIMIT 50", [], (err2, movimientos) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ estado, movimientos });
        });
    });
});

// 4. INGRESAR CAPITAL MANUALMENTE
app.post('/api/almacen/ingresar-capital', (req, res) => {
    const { monto, descripcion, usuario_nombre } = req.body;
    const montoNum = parseFloat(monto);
    if (isNaN(montoNum) || montoNum <= 0) return res.status(400).json({ error: "Ingresa un monto válido." });

    db.serialize(() => {
        db.run("UPDATE taller_estado SET capital = capital + ? WHERE id = 1", [montoNum]);
        db.run("INSERT INTO movimientos_capital (tipo, descripcion, monto, usuario_nombre) VALUES ('ingreso_capital', ?, ?, ?)",
            [descripcion || 'Inyección de Capital', montoNum, usuario_nombre || 'Admin']);
        res.json({ message: "Capital ingresado correctamente." });
    });
});

// 5. COMPRAR MOTORES A FÁBRICA
app.post('/api/almacen/comprar-motor', (req, res) => {
    const { tipo_motor, cantidad, usuario_nombre } = req.body;
    const cant = parseInt(cantidad);
    if (isNaN(cant) || cant <= 0) return res.status(400).json({ error: "Cantidad inválida." });

    const costoUnitario = tipo_motor === 'v12' ? 300000 : 40000;
    const costoTotal = costoUnitario * cant;

    db.get("SELECT capital FROM taller_estado WHERE id = 1", [], (err, estado) => {
        if (err || !estado) return res.status(500).json({ error: "Error al consultar estado." });

        if (estado.capital < costoTotal) {
            return res.status(400).json({ error: `Capital insuficiente. Requiere $${costoTotal.toLocaleString()} y tienes $${estado.capital.toLocaleString()}` });
        }

        const columnaStock = tipo_motor === 'v12' ? 'stock_v12' : 'stock_v8';
        const desc = `Compra de ${cant}x Motor ${tipo_motor.toUpperCase()} a Fábrica`;

        db.serialize(() => {
            db.run(`UPDATE taller_estado SET capital = capital - ?, ${columnaStock} = ${columnaStock} + ? WHERE id = 1`, [costoTotal, cant]);
            db.run("INSERT INTO movimientos_capital (tipo, descripcion, monto, usuario_nombre) VALUES (?, ?, ?, ?)",
                [`compra_${tipo_motor}`, desc, -costoTotal, usuario_nombre || 'Admin']);
            res.json({ message: `Comprados ${cant}x Motores ${tipo_motor.toUpperCase()} con éxito.` });
        });
    });
});

// 6. LISTA DE USUARIOS (ADMIN)
app.get('/api/usuarios', (req, res) => {
    db.all("SELECT id, nombre, usuario, COALESCE(rol, 'empleado') as rol, COALESCE(comision_porcentaje, 30) as comision_porcentaje FROM usuarios", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 7. MODIFICAR USUARIO (ADMIN)
app.put('/api/usuarios/modificar', (req, res) => {
    const { usuario_id, comision_porcentaje, rol } = req.body;
    const sql = `UPDATE usuarios SET comision_porcentaje = ?, rol = ? WHERE id = ?`;
    db.run(sql, [comision_porcentaje, rol, usuario_id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Usuario actualizado." });
    });
});

// 8. REGISTRAR FACTURA
app.post('/api/facturas', (req, res) => {
    const { usuario_id, cliente, items, descuento_porcentaje } = req.body;

    if (!usuario_id) return res.status(400).json({ error: "Debes iniciar sesión primero." });

    db.get("SELECT nombre, COALESCE(comision_porcentaje, 30) as comision FROM usuarios WHERE id = ?", [usuario_id], (err, user) => {
        if (err || !user) return res.status(400).json({ error: "Usuario no encontrado." });

        let v8Necesarios = 0;
        let v12Necesarios = 0;

        items.forEach(item => {
            if (item.id === 8 || item.id === 18 || item.id === 19) {
                v8Necesarios += item.cantidad;
            }
            if (item.id === 7 || item.id === 20 || item.id === 21) {
                v12Necesarios += item.cantidad;
            }
        });

        db.get("SELECT stock_v8, stock_v12 FROM taller_estado WHERE id = 1", [], (errStock, estado) => {
            if (errStock || !estado) return res.status(500).json({ error: "Error verificando almacén." });

            if (v8Necesarios > 0 && estado.stock_v8 < v8Necesarios) {
                return res.status(400).json({ error: `Almacén insuficiente: Se requieren ${v8Necesarios} Motor(es) V8 y hay ${estado.stock_v8} en stock.` });
            }
            if (v12Necesarios > 0 && estado.stock_v12 < v12Necesarios) {
                return res.status(400).json({ error: `Almacén insuficiente: Se requieren ${v12Necesarios} Motor(es) V12 y hay ${estado.stock_v12} en stock.` });
            }

            const pctComision = user.comision / 100;
            let subtotal_cliente = 0;
            let coste_fabrica_total = 0;

            items.forEach(item => {
                subtotal_cliente += item.venta * item.cantidad;
                coste_fabrica_total += item.costo * item.cantidad;
            });

            const descuento = subtotal_cliente * ((descuento_porcentaje || 0) / 100);
            const total_cliente = subtotal_cliente - descuento;
            const ganancia_neta = total_cliente - coste_fabrica_total;
            const comision_empleado = ganancia_neta > 0 ? ganancia_neta * pctComision : 0;
            const itemsJSON = JSON.stringify(items);

            db.serialize(() => {
                db.run(`INSERT INTO facturas (usuario_id, cliente, total_cliente, coste_fabrica_total, ganancia_neta, comision_empleado, descuento_porcentaje, items_json) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [usuario_id, cliente || 'Cliente General', total_cliente, coste_fabrica_total, ganancia_neta, comision_empleado, descuento_porcentaje || 0, itemsJSON],
                    function(errFactura) {
                        if (errFactura) return res.status(500).json({ error: errFactura.message });
                        const facturaId = this.lastID;

                        if (v8Necesarios > 0 || v12Necesarios > 0) {
                            db.run(`UPDATE taller_estado SET stock_v8 = stock_v8 - ?, stock_v12 = stock_v12 - ? WHERE id = 1`, [v8Necesarios, v12Necesarios]);
                            db.run(`INSERT INTO movimientos_capital (tipo, descripcion, monto, usuario_nombre) VALUES ('despacho_almacen', ?, 0, ?)`,
                                [`Salida Orden #${facturaId} (Cliente: ${cliente}): ${v8Necesarios > 0 ? v8Necesarios + 'x V8 ' : ''}${v12Necesarios > 0 ? v12Necesarios + 'x V12' : ''}`, user.nombre]);
                        }

                        res.json({
                            id: facturaId,
                            subtotal: subtotal_cliente,
                            total: total_cliente,
                            comision: comision_empleado,
                            porcentaje_aplicado: user.comision
                        });
                    }
                );
            });
        });
    });
});

// 9. HISTORIAL PERSONAL
app.get('/api/mis-facturas/:usuario_id', (req, res) => {
    const { usuario_id } = req.params;
    const sql = `SELECT * FROM facturas WHERE usuario_id = ? ORDER BY fecha DESC`;
    db.all(sql, [usuario_id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 10. HISTORIAL GLOBAL (ADMIN)
app.get('/api/admin/todas-facturas', (req, res) => {
    const sql = `
        SELECT f.*, u.nombre as trabajador_nombre, u.usuario as trabajador_usuario 
        FROM facturas f 
        JOIN usuarios u ON f.usuario_id = u.id 
        ORDER BY f.fecha DESC
    `;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 11. TOP TRABAJADORES
app.get('/api/top-trabajadores', (req, res) => {
    const sql = `
        SELECT u.id, u.nombre, u.usuario, COALESCE(u.comision_porcentaje, 30) as comision_porcentaje,
               COUNT(f.id) as total_facturas,
               COALESCE(SUM(f.total_cliente), 0) as total_vendido,
               COALESCE(SUM(f.ganancia_neta), 0) as ganancia_generada,
               COALESCE(SUM(f.comision_empleado), 0) as comision_ganada
        FROM usuarios u
        LEFT JOIN facturas f ON u.id = f.usuario_id
        GROUP BY u.id
        ORDER BY ganancia_generada DESC
    `;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor ejecutándose en puerto ${PORT}`));