const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'taller.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('Error al conectar con SQLite:', err.message);
    else console.log('Base de datos SQLite conectada con éxito.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        usuario TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        comision_porcentaje REAL DEFAULT 30,
        rol TEXT DEFAULT 'empleado'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS facturas (
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
});

module.exports = db;