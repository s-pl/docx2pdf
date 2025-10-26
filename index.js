const express = require('express');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const os = require('os');
const topdf = require('./utils');



const app = express();
const server = createServer(app);
const io = new Server(server);
app.use(express.static('public'))
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public/index.html'));
});

io.on('connection', (socket) => {
  console.log('a user connected');
  socket.on('upload', async (file) => {
    try {
      // file[0] es el buffer/Uint8Array enviado desde el cliente
      const incoming = file && file[0];
      if (!incoming) {
        socket.emit('error', 'No file received');
        return;
      }

      // Asegurar Buffer de Node
      const buffer = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming);

      // Optional: quick size check before queueing
      const maxBytes = Number(process.env.MAX_DOCX_BYTES) || 15 * 1024 * 1024; // 15MB default
      if (buffer.length > maxBytes) {
        socket.emit('error', `File too large (${buffer.length} bytes). Max ${maxBytes}`);
        return;
      }

      // Convertir de forma asíncrona (no bloquea event-loop)
      const pdfBuffer = await topdf.convertBuffer(buffer, { maxBytes, timeoutMs: 60_000, keepActive: false });

      // Enviar PDF resultante de vuelta al cliente como binario
      socket.emit('converted', pdfBuffer);

    } catch (err) {
      console.error('Conversion error:', err && err.stack ? err.stack : err);
      socket.emit('error', String(err && err.message ? err.message : err));
    }
  });
});

server.listen(3000, () => {
  console.log('server running at http://localhost:3000');
});