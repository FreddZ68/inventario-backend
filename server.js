const multer = require("multer");
const path = require("path");
const express = require("express");
const mysql = require("mysql2");
const bodyParser = require("body-parser");
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const SECRET = "clave_secreta_inventario"; // Llave para firmar los tokens

const app = express();
app.use(bodyParser.json());
app.use(express.json());
app.use(cors());

// 1. Configurar dónde se guardan las fotos
const upload = multer({ dest: "uploads/" });

// 2. Hacer que la carpeta sea pública para ver las fotos desde la App
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// 3. Hacer pública la carpeta de QR (requerido por la Guía 18)
app.use('/qrs', express.static(path.join(__dirname, 'qrs')));



const QRCode = require('qrcode');
const fs = require('fs');

// Crear carpeta qrs si no existe
if (!fs.existsSync('./qrs')) {
  fs.mkdirSync('./qrs');
}

function generarQR(materialId, nombre) {
  const ruta = `./qrs/${materialId}.png`;
  
  QRCode.toFile(ruta, materialId, {
    color: { dark: '#000000', light: '#FFFFFF' },
    margin: 2,
    width: 300
  }, function (err) {
    if (err) throw err;
    console.log(`QR generado en: ${ruta}`);
  });
}

// Nota: se quitó la llamada de ejemplo generarQR("4", ...) que se ejecutaba
// en cada arranque del servidor. Llama a generarQR(id, nombre) solo cuando
// registres un material nuevo, no al iniciar el servidor.

// Conexión a MySQL/MariaDB usando variables de entorno.
// En Railway estas variables las crea automáticamente el servicio de MySQL.
// Los valores por defecto (localhost, 3308, etc.) solo se usan si trabajas
// en tu máquina local con XAMPP.
const conexion = mysql.createConnection({
  host: process.env.MYSQLHOST || 'localhost',
  user: process.env.MYSQLUSER || 'root',
  password: process.env.MYSQLPASSWORD || '',
  database: process.env.MYSQLDATABASE || 'railway',
  port: process.env.MYSQLPORT || 3306
});

conexion.connect((err) => {
  if (err) {
    console.error('Error conectando a la base de datos:', err);
    return;
  }
  console.log('Bienvendio a Inventario');
});



app.post("/registro", (req, res) => {
  const { nombre, correo, password, rol } = req.body;
  const hashedPassword = bcrypt.hashSync(password, 8); // Encriptar clave
  const sql = "INSERT INTO usuarios (nombre, correo, password, rol) VALUES (?, ?, ?, ?)";
  
  conexion.query(sql, [nombre, correo, hashedPassword, rol], (err, result) => {
    if (err) return res.json({ status: "error", mensaje: "El correo ya existe" });
    res.json({ status: "ok", mensaje: "Usuario creado con éxito" });
  });
});

// --- Iniciar Sesión ---
app.post("/login", (req, res) => {
  const { correo, password } = req.body; // Cambiado a correo/password
  const sql = "SELECT * FROM usuarios WHERE correo = ?";
  
  conexion.query(sql, [correo], (err, result) => {
    if (err || result.length === 0) {
      return res.json({ status: "fail", mensaje: "Usuario no encontrado" });
    }

    const usuario = result[0];
    // Comparar contraseña escrita con la encriptada en BD
    const passwordValido = bcrypt.compareSync(password, usuario.password);

    if (!passwordValido) {
      return res.json({ status: "fail", mensaje: "Contraseña incorrecta" });
    }

    // Generar Token JWT
    const token = jwt.sign({ id: usuario.id, rol: usuario.rol }, SECRET, { expiresIn: "2h" });

    res.json({ 
      status: "ok", 
      rol: usuario.rol, 
      token: token,
      nombre: usuario.nombre 
    });
  });
});

function verificarToken(req, res, next) {
  const token = req.headers["authorization"];
  if (!token) return res.status(403).json({ mensaje: "Token requerido" });

  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ mensaje: "Token inválido" });
    req.usuario = decoded;
    next();
  });
}

// --- Registrar Material ---
app.post("/materiales", upload.single("foto"), (req, res) => {
    const { nombre, cantidad, estado, categoria } = req.body;
    // Si se subió foto, guardamos la ruta; si no, queda null
    const foto = req.file ? req.file.path.replaceAll('\\', '/') : null;
    
    const sql = "INSERT INTO materiales (nombre, cantidad, estado, categoria, foto) VALUES (?, ?, ?, ?, ?)";
    
    conexion.query(sql, [nombre, cantidad, estado, categoria, foto], (err, result) => {
        if (err) return res.json({ status: "error", mensaje: err });
        res.json({ status: "ok", mensaje: "Material guardado con éxito" });
    });
});
app.delete("/materiales/:id", (req, res) => {
    const sql = "DELETE FROM materiales WHERE id = ?";
    conexion.query(sql, [req.params.id], (err, result) => {
        if (err) res.json({ status: "error" });
        else res.json({ status: "ok" });
    });
});

// --- Registrar Préstamo ---
app.post("/prestamos", (req, res) => {
  // 1. Recibimos los datos del préstamo
  const { material_id, fecha_prestamo, maestro } = req.body;

  // 2. Definimos la consulta para revisar si este maestro tiene permiso para prestar este material
  const sqlPermiso = "SELECT * FROM permisos WHERE maestro = ? AND material_id = ? AND puede_prestar = TRUE";
 
  // 3. Ejecutamos primero la revisión de permisos
  conexion.query(sqlPermiso, [maestro, material_id], (err, result) => {
    if (err) {
      return res.json({ status: "error", mensaje: "Error al validar permisos: " + err });
    } 
    
    // 4. Si no se encontró ningún registro en la tabla de permisos que coincida
    if (result.length === 0) {
      return res.json({ 
        status: "fail", 
        mensaje: "No tienes permiso para prestar este material. Contacta al administrador." 
      });
    } 
    
    // 5. SI TIENE PERMISO, procedemos a insertar el préstamo como lo hacíamos antes
    else {
      const sqlInsert = "INSERT INTO prestamos (material_id, fecha_prestamo, maestro) VALUES (?, ?, ?)";
      
      conexion.query(sqlInsert, [material_id, fecha_prestamo, maestro], (err2, result2) => {
        if (err2) {
          res.json({ status: "error", mensaje: "Error al registrar el préstamo: " + err2 });
        } else {
          res.json({ status: "ok", mensaje: "¡Préstamo registrado exitosamente!" });
        }
      });
    }
  });
});
app.get("/materiales", (req, res) => {
    const sql = "SELECT * FROM materiales";

    conexion.query(sql, (err, results) => {
        if (err) {
            console.error("Error al obtener materiales:", err);
            res.status(500).json({ error: "Error en el servidor" });
        } else {
            // Enviamos el array directamente para que Flutter lo reciba como materiales = jsonDecode(...)
            res.json(results);
        }
    });
});

// --- Consultar préstamos con nombre del material (CORREGIDO) ---
// --- 1. Obtener lista de maestros (para los Dropdowns) ---
app.get("/usuarios/maestros", (req, res) => {
    const sql = "SELECT id, nombre FROM usuarios WHERE rol = 'maestro'";
    conexion.query(sql, (err, results) => {
        if (err) res.status(500).json(err);
        else res.json(results);
    });
});

// --- 2. Actualizar lista de préstamos con nombres (JOIN) ---
app.get("/prestamos", (req, res) => {
    const sql = `
        SELECT p.id, m.nombre AS material, p.maestro, 
        p.fecha_prestamo, p.fecha_devolucion
        FROM prestamos p
        INNER JOIN materiales m ON p.material_id = m.id
    `;
    conexion.query(sql, (err, result) => {
        if (err) res.json({ status: "error", mensaje: err });
        else res.json(result); 
    });
});

// --- Actualizar fecha de devolución manualmente ---
app.put("/prestamos/:id", (req, res) => {
  const { fecha_devolucion } = req.body;
  const { id } = req.params;

  console.log("Intentando actualizar ID:", id); // Mira si el ID es correcto
  console.log("Nueva fecha recibida:", fecha_devolucion); // Mira si llega "2026-08-25" o llega undefined

  const sql = "UPDATE prestamos SET fecha_devolucion = ? WHERE id = ?";
  
  conexion.query(sql, [fecha_devolucion, id], (err, result) => {
    if (err) {
      console.error("Error de SQL:", err);
      return res.status(500).json({ status: "error" });
    }
    
    console.log("Filas afectadas:", result.affectedRows); // Si sale 0, es que el ID no existe
    res.json({ status: "ok" });
  });
});

// --- Marcar devolución con fecha actual (NOW) ---
// RUTA PARA MARCAR COMO DEVUELTO
app.put("/prestamos/devolver/:id", (req, res) => {
    const idPrestamo = req.params.id;
    
    // Primero buscamos quién es el maestro de ese préstamo
    const sqlMaestro = "SELECT maestro, material_id FROM prestamos WHERE id = ?";
    
    conexion.query(sqlMaestro, [idPrestamo], (err, result) => {
        if (result.length > 0) {
            const { maestro, material_id } = result[0];

            // Validamos si ese maestro tiene permiso de devolver ese material
            const sqlValidar = "SELECT * FROM permisos WHERE maestro = ? AND material_id = ? AND puede_devolver = TRUE";
            
            conexion.query(sqlValidar, [maestro, material_id], (err2, result2) => {
                if (result2.length === 0) {
                    return res.json({ status: "fail", mensaje: "No tienes permiso para devolver este material" });
                }

                // Si tiene permiso, procedemos con la devolución
                const sqlUpdate = "UPDATE prestamos SET fecha_devolucion = NOW() WHERE id = ?";
                conexion.query(sqlUpdate, [idPrestamo], (err3, result3) => {
                    res.json({ status: "ok", mensaje: "Material devuelto" });
                });
            });
        }
    });
});
// --- 1. Devolución desde la LISTA (usa ID del préstamo) ---
app.put("/prestamos/devolver/id/:id", (req, res) => {
    const idPrestamo = req.params.id;
    const { rol_actual } = req.body;

    const sqlMaestro = "SELECT maestro, material_id FROM prestamos WHERE id = ?";
    
    conexion.query(sqlMaestro, [idPrestamo], (err, result) => {
        if (err || result.length === 0) return res.json({ status: "error", mensaje: "Préstamo no encontrado" });
        
        const { maestro, material_id } = result[0];

        // Si es administrador, se salta la validación de permisos
        if (rol_actual === "administrador") {
            const sqlUpdate = "UPDATE prestamos SET fecha_devolucion = NOW() WHERE id = ?";
            return conexion.query(sqlUpdate, [idPrestamo], (err3, result3) => {
                res.json({ status: "ok", mensaje: "Material devuelto con éxito" });
            });
        }

        const sqlValidar = "SELECT * FROM permisos WHERE maestro = ? AND material_id = ? AND puede_devolver = TRUE";
        conexion.query(sqlValidar, [maestro, material_id], (err2, result2) => {
            if (result2.length === 0) {
                return res.json({ status: "fail", mensaje: "No tienes permiso para devolver este material" });
            }
            const sqlUpdate = "UPDATE prestamos SET fecha_devolucion = NOW() WHERE id = ?";
            conexion.query(sqlUpdate, [idPrestamo], (err3, result3) => {
                res.json({ status: "ok", mensaje: "Material devuelto con éxito" });
            });
        });
    });
});

// --- 2. Devolución desde el QR (usa ID del material) ---
app.put("/prestamos/devolver/qr/:material_id", (req, res) => {
    const material_id = req.params.material_id;
    // Busca el último préstamo de ese material que no se haya devuelto
    const sql = "UPDATE prestamos SET fecha_devolucion = NOW() WHERE material_id = ? AND fecha_devolucion IS NULL LIMIT 1";
    
    conexion.query(sql, [material_id], (err, result) => {
        if (err) return res.json({ status: "error", mensaje: err });
        if (result.affectedRows === 0) {
            return res.json({ status: "fail", mensaje: "No hay préstamos pendientes para este material" });
        }
        res.json({ status: "ok", mensaje: "Entrega registrada vía QR" });
    });
});

// Endpoint para devolución por QR (usa el material_id)
app.put("/prestamos/devolver_qr/:material_id", (req, res) => {
    const material_id = req.params.material_id;
    
    // Busca el préstamo más reciente de ese material que NO haya sido devuelto
    const sql = "UPDATE prestamos SET fecha_devolucion = NOW() WHERE material_id = ? AND fecha_devolucion IS NULL LIMIT 1";
    
    conexion.query(sql, [material_id], (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err });
        } else if (result.affectedRows === 0) {
            res.json({ status: "fail", mensaje: "No hay préstamos pendientes para este material" });
        } else {
            res.json({ status: "ok", mensaje: "Material devuelto exitosamente vía QR" });
        }
    });
});
app.put("/prestamos/devolver/:material_id", (req, res) => {
  const sql = "UPDATE prestamos SET fecha_devolucion = NOW() WHERE material_id = ? AND fecha_devolucion IS NULL";
  
  conexion.query(sql, [req.params.material_id], (err, result) => {
    if (err) {
      res.json({ status: "error", mensaje: err });
    } else {
      res.json({ status: "ok", mensaje: "Entrega registrada" });
    }
  });
});
// Total de préstamos
app.get("/reportes/total", (req, res) => {
  const sql = "SELECT COUNT(*) AS total FROM prestamos";
  conexion.query(sql, (err, result) => {
    if (err) res.json({ status: "error", mensaje: err });
    else res.json(result[0]);
  });
});

// Préstamos pendientes (sin devolución)
app.get("/reportes/pendientes", (req, res) => {
  const sql = "SELECT COUNT(*) AS pendientes FROM prestamos WHERE fecha_devolucion IS NULL";
  conexion.query(sql, (err, result) => {
    if (err) res.json({ status: "error", mensaje: err });
    else res.json(result[0]);
  });
});

// Préstamos devueltos
app.get("/reportes/devueltos", (req, res) => {
  const sql = "SELECT COUNT(*) AS devueltos FROM prestamos WHERE fecha_devolucion IS NOT NULL";
  conexion.query(sql, (err, result) => {
    if (err) res.json({ status: "error", mensaje: err });
    else res.json(result[0]);
  });
});

// Endpoint de notificaciones en Node.js
// Dónde va: En server.js
app.get("/notificaciones", (req, res) => {
  const sql = "SELECT * FROM prestamos WHERE fecha_devolucion IS NULL  ORDER BY fecha_prestamo ASC";
  conexion.query(sql, (err, result) => {
    if (err) {
      res.json({ status: "error", mensaje: err });
    } else {
      res.json(result);
    }
  });
});
app.get("/notificaciones/:maestro", (req, res) => {
  const sql = "SELECT * FROM prestamos WHERE maestro = ? AND fecha_devolucion IS NULL ORDER BY fecha_prestamo ASC";
  
  conexion.query(sql, [req.params.maestro], (err, result) => {
    if (err) {
      res.json({ status: "error", mensaje: err });
    } else {
      res.json(result);
    }
  });
});

app.post("/permisos", (req, res) => {
 const { maestro, material_id, puede_ver, puede_prestar, puede_devolver } = req.body;
 const sql = "INSERT INTO permisos (maestro, material_id, puede_ver, puede_prestar, puede_devolver) VALUES (?, ?, ?, ?, ?)";
 conexion.query(sql, [maestro, material_id, puede_ver, puede_prestar, puede_devolver], (err, result) => {
    if (err) {
        res.json({ status: "error", mensaje: err });
    } else {
        res.json({ status: "ok", mensaje: "Permiso asignado" });
    }
 });
});

// --- ENDPOINT PARA REPORTES EN PDF ---
app.get("/reportes/pdf", (req, res) => {
    const { maestro, fecha_inicio, fecha_fin } = req.query;

    // Consulta con filtros dinámicos
    let sql = `SELECT p.id, m.nombre as material, p.maestro, p.fecha_prestamo 
               FROM prestamos p 
               INNER JOIN materiales m ON p.material_id = m.id WHERE 1=1`;
    let params = [];

    if (maestro) { sql += " AND p.maestro LIKE ?"; params.push(`%${maestro}%`); }
    if (fecha_inicio) { sql += " AND p.fecha_prestamo >= ?"; params.push(fecha_inicio); }
    if (fecha_fin) { sql += " AND p.fecha_prestamo <= ?"; params.push(fecha_fin); }

    conexion.query(sql, params, (err, results) => {
        if (err) return res.status(500).json(err);

        const doc = new PDFDocument();
        // Configurar cabeceras para que el navegador/celular entienda que es un PDF
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=reporte.pdf');

        doc.pipe(res);
        doc.fontSize(20).text('Reporte de Inventario - INFRAMEN', { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(`Filtros: Maestro: ${maestro || 'Todos'}, Inicio: ${fecha_inicio || 'N/A'}, Fin: ${fecha_fin || 'N/A'}`);
        doc.moveDown();

        results.forEach(row => {
            doc.text(`ID: ${row.id} | Material: ${row.material} | Maestro: ${row.maestro} | Fecha: ${row.fecha_prestamo}`);
            doc.moveDown(0.5);
        });

        doc.end();
    });
});

// --- ENDPOINT PARA REPORTES EN EXCEL ---
app.get("/reportes/excel", (req, res) => {
    const { maestro, fecha_inicio, fecha_fin } = req.query;

    let sql = `SELECT p.id, m.nombre as material, p.maestro, p.fecha_prestamo 
               FROM prestamos p 
               INNER JOIN materiales m ON p.material_id = m.id WHERE 1=1`;
    let params = [];

    if (maestro) { sql += " AND p.maestro LIKE ?"; params.push(`%${maestro}%`); }
    if (fecha_inicio) { sql += " AND p.fecha_prestamo >= ?"; params.push(fecha_inicio); }
    if (fecha_fin) { sql += " AND p.fecha_prestamo <= ?"; params.push(fecha_fin); }

    conexion.query(sql, params, async (err, results) => {
        if (err) return res.status(500).json(err);

        let workbook = new ExcelJS.Workbook();
        let worksheet = workbook.addWorksheet('Reporte');

        worksheet.columns = [
            { header: 'ID', key: 'id', width: 10 },
            { header: 'Material', key: 'material', width: 30 },
            { header: 'Maestro', key: 'maestro', width: 30 },
            { header: 'Fecha Préstamo', key: 'fecha', width: 20 },
        ];

        results.forEach(row => {
            worksheet.addRow({
                id: row.id,
                material: row.material,
                maestro: row.maestro,
                fecha: row.fecha_prestamo
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=reporte.xlsx');

        await workbook.xlsx.write(res);
        res.end();
    });
});

// Endpoint de métricas para el Dashboard
app.get("/dashboard", (req, res) => {
  const sql = `
    SELECT 
      (SELECT COUNT(*) FROM materiales) AS total_materiales,
      (SELECT COUNT(*) FROM prestamos WHERE fecha_devolucion IS NULL) AS prestados,
      (SELECT COUNT(*) FROM prestamos WHERE fecha_devolucion IS NOT NULL) AS devueltos,
      (SELECT COUNT(*) FROM materiales WHERE estado = 'dañado') AS danados
  `;

  conexion.query(sql, (err, result) => {
    if (err) {
      res.json({ status: "error", mensaje: err });
    } else {
      res.json(result[0]);
    }
  });
});

// ======================================================
// HISTORIAL DETALLADO DE PRÉSTAMOS (Guía 17)
// ======================================================
app.get("/historial", (req, res) => {
  const { maestro, material, fecha_inicio, fecha_fin } = req.query;

  let sql = `
    SELECT p.id, m.nombre AS material, p.maestro AS docente,
           p.fecha_prestamo, p.fecha_devolucion
    FROM prestamos p
    JOIN materiales m ON p.material_id = m.id
    WHERE 1=1
  `;
  const params = [];

  if (maestro) {
    sql += " AND p.maestro = ?";
    params.push(maestro);
  }
  if (material) {
    sql += " AND m.nombre = ?";
    params.push(material);
  }
  if (fecha_inicio && fecha_fin) {
    sql += " AND p.fecha_prestamo BETWEEN ? AND ?";
    params.push(fecha_inicio, fecha_fin);
  }

  sql += " ORDER BY p.fecha_prestamo DESC";

  conexion.query(sql, params, (err, result) => {
    if (err) return res.json({ status: "error", mensaje: err });
    res.json(result);
  });
});



// Railway asigna el puerto automáticamente mediante la variable PORT.
// En local, si no existe esa variable, usa 3000 como antes.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
