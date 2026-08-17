const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'taller.db');

// Si existe la base de datos previa, se elimina automáticamente para limpiar residuos
if (fs.existsSync(dbPath)) {
    try {
        fs.unlinkSync(dbPath);
        console.log("--> Base de datos previa eliminada correctamente.");
    } catch (e) {
        console.log("--> Reiniciando conexión de base de datos...");
    }
}

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // Crear tabla de usuarios limpia
    db.run(`CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        usuario TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        rol TEXT DEFAULT 'empleado'
    )`);

    // Crear tabla de facturas limpia
    db.run(`CREATE TABLE IF NOT EXISTS facturas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER NOT NULL,
        cliente TEXT DEFAULT 'Cliente General',
        total_cliente REAL NOT NULL,
        coste_fabrica_total REAL NOT NULL,
        ganancia_neta REAL NOT NULL,
        comision_empleado REAL NOT NULL,
        descuento_porcentaje REAL DEFAULT 0,
        estado_pago TEXT DEFAULT 'pendiente',
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(usuario_id) REFERENCES usuarios(id)
    )`);
});

module.exports = db;