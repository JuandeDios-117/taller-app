const { createClient } = require('@libsql/client');

let rawUrl = (process.env.TURSO_DATABASE_URL || 'file:taller.db').trim();
if (rawUrl.startsWith('libsql://')) {
    rawUrl = rawUrl.replace('libsql://', 'https://');
}

const authToken = (process.env.TURSO_AUTH_TOKEN || '').trim();

const client = createClient({
    url: rawUrl,
    authToken: authToken
});

async function initDB() {
    try {
        await client.execute(`CREATE TABLE IF NOT EXISTS usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            usuario TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            comision_porcentaje REAL DEFAULT 30,
            rol TEXT DEFAULT 'empleado'
        )`);

        await client.execute(`CREATE TABLE IF NOT EXISTS facturas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario_id INTEGER,
            cliente TEXT,
            total_cliente REAL,
            coste_fabrica_total REAL,
            ganancia_neta REAL,
            comision_empleado REAL,
            descuento_porcentaje REAL DEFAULT 0,
            estado_pago TEXT DEFAULT 'pendiente',
            items_json TEXT,
            fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (usuario_id) REFERENCES usuarios (id)
        )`);

        await client.execute(`CREATE TABLE IF NOT EXISTS taller_estado (
            id INTEGER PRIMARY KEY,
            capital REAL DEFAULT 0,
            stock_v8 INTEGER DEFAULT 0,
            stock_v12 INTEGER DEFAULT 0
        )`);

        await client.execute(`CREATE TABLE IF NOT EXISTS movimientos_capital (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tipo TEXT,
            descripcion TEXT,
            monto REAL,
            usuario_nombre TEXT,
            fecha DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Índices de aceleración de consultas
        await client.execute(`CREATE INDEX IF NOT EXISTS idx_facturas_usuario ON facturas(usuario_id)`);
        await client.execute(`CREATE INDEX IF NOT EXISTS idx_facturas_fecha ON facturas(fecha DESC)`);
        await client.execute(`CREATE INDEX IF NOT EXISTS idx_movimientos_fecha ON movimientos_capital(fecha DESC)`);

        const estado = await client.execute("SELECT COUNT(*) as total FROM taller_estado");
        if (estado.rows[0].total === 0) {
            await client.execute("INSERT INTO taller_estado (id, capital, stock_v8, stock_v12) VALUES (1, 0, 0, 0)");
        }
        console.log("Base de datos conectada con índices optimizados.");
    } catch (err) {
        console.error("Error al inicializar base de datos:", err);
    }
}

initDB();

module.exports = client;