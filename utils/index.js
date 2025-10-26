const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');
const assert = require('assert');
const os = require('os');

const DEFAULT_MAX_BYTES = 15 * 1024 * 1024; // 15 MB
const DEFAULT_TIMEOUT_MS = 60 * 1000; // 60s
const DEFAULT_CONCURRENCY = 2;

const packageVersion = (() => {
  try { return require('./package.json').version; } catch (e) { return '0.0.0'; }
})();

// Simple in-memory job queue to limit concurrency and avoid blocking the event-loop
let concurrency = Number(process.env.DOCX2PDF_CONCURRENCY) || DEFAULT_CONCURRENCY;
let running = 0;
const queue = [];

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    processQueue();
  });
}

function processQueue() {
  if (running >= concurrency) return;
  const item = queue.shift();
  if (!item) return;
  running++;
  (async () => {
    try {
      const r = await item.fn();
      item.resolve(r);
    } catch (e) {
      item.reject(e);
    } finally {
      running--;
      // schedule next tick
      setImmediate(processQueue);
    }
  })();
}

function validateDocxBuffer(buffer, maxBytes = DEFAULT_MAX_BYTES) {
  if (!buffer) throw new Error('No buffer provided');
  if (buffer.length > maxBytes) throw new Error(`File too large (${buffer.length} bytes), max ${maxBytes}`);
  // DOCX is a ZIP file: check PK\x03\x04
  if (buffer.length < 4) throw new Error('File too small to be a docx');
  if (!(buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04)) {
    throw new Error('Invalid DOCX file (not a zip archive)');
  }
}

async function extractImages(inputPath, outputDir) {
  if (!inputPath) return;
  if (!await exists(inputPath)) return;
  await fsp.mkdir(outputDir, { recursive: true });
  const zip = new AdmZip(inputPath);
  const zipEntries = zip.getEntries();
  for (const entry of zipEntries) {
    if (entry.entryName.startsWith('word/media/')) {
      const imageName = entry.entryName.split('/').pop();
      const imagePath = path.join(outputDir, imageName);
      await fsp.writeFile(imagePath, entry.getData());
    }
  }
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch (e) { return false; }
}

function getPlatformCommand() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  return null;
}

function spawnConversion(inputFile, outputFile, keepActive, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    const platform = process.platform;

    if (platform === 'win32') {
      const scriptPath = path.resolve(__dirname, 'convert.ps1');
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, inputFile, outputFile, keepActive ? 'true' : 'false'];
      child = spawn('powershell', args, { stdio: 'ignore' });
    } else if (platform === 'darwin') {
      const scriptPath = path.resolve(__dirname, 'convert.sh');
      child = spawn('sh', [scriptPath, inputFile, outputFile, keepActive ? 'true' : 'false'], { stdio: 'ignore' });
    } else if (platform === 'linux') {
      // unoconv writes output; use -o to set output path
      child = spawn('unoconv', ['-f', 'pdf', '-o', outputFile, inputFile], { stdio: 'ignore' });
    } else {
      return reject(new Error('Unsupported platform for conversion'));
    }

    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    }, timeoutMs || DEFAULT_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      if (timedOut) return reject(new Error('Conversion timed out'));
      if (code !== 0) return reject(new Error(`Conversion failed with code ${code}${signal ? ' signal '+signal : ''}`));
      resolve();
    });
  });
}

/**
 * Convert a DOCX buffer to PDF buffer asynchronously. Uses an internal queue with limited concurrency.
 * Returns a Promise<Buffer> with the PDF contents.
 */
async function convertBuffer(buffer, opts = {}) {
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const keepActive = !!opts.keepActive;

  validateDocxBuffer(buffer, maxBytes);

  return enqueue(async () => {
    const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'docx2pdf-'));
    const inputPath = path.join(tmpBase, 'input.docx');
    const outputPath = opts.outputPath ? path.resolve(opts.outputPath) : path.join(tmpBase, 'output.pdf');

    try {
      await fsp.writeFile(inputPath, buffer, { mode: 0o600 });

      // perform conversion without blocking event loop
      await spawnConversion(inputPath, outputPath, keepActive, timeoutMs);

      // read result
      const pdf = await fsp.readFile(outputPath);
      return pdf;
    } finally {
      // cleanup - remove tmpBase recursively
      try { await fsp.rm(tmpBase, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  });
}

async function extractImagesFromBuffer(buffer, outputDir) {
  if (!buffer) throw new Error('Buffer required');
  if (!Buffer.isBuffer(buffer)) {
    if (buffer instanceof Uint8Array) buffer = Buffer.from(buffer);
    else throw new Error('Provided data is not a Buffer or Uint8Array');
  }
  const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'docx2pdf-'));
  const inputPath = path.join(tmpBase, 'input.docx');
  try {
    await fsp.writeFile(inputPath, buffer, { mode: 0o600 });
    await extractImages(inputPath, outputDir);
  } finally {
    try { await fsp.rm(tmpBase, { recursive: true, force: true }); } catch (e) { }
  }
}

module.exports = {
  convertBuffer,
  extractImagesFromBuffer,
  extractImages,
  packageVersion,
  // helpers
  _internal: {
    validateDocxBuffer,
    spawnConversion,
    setConcurrency: (c) => { concurrency = Number(c) || concurrency; },
  }
};
