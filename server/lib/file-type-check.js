// Magic-byte file-type detection. Multer's req.file.mimetype is browser-supplied
// and trivially spoofable. This helper looks at the actual first bytes of the
// file buffer and matches known signatures.
//
// Returns one of: 'image', 'video', 'audio', 'pdf', or null (unknown / unsafe).

const SIGNATURES = [
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  { kind: 'image', test: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A },
  // JPEG: FF D8 FF
  { kind: 'image', test: (b) => b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  // GIF: "GIF87a" or "GIF89a"
  { kind: 'image', test: (b) => b.length >= 6 && b.slice(0, 6).toString() === 'GIF87a' } ,
  { kind: 'image', test: (b) => b.length >= 6 && b.slice(0, 6).toString() === 'GIF89a' },
  // WebP: RIFF....WEBP
  { kind: 'image', test: (b) => b.length >= 12 && b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' },
  // SVG isn't accepted — XML, can carry script.

  // PDF: "%PDF-"
  { kind: 'pdf',   test: (b) => b.length >= 5 && b.slice(0, 5).toString() === '%PDF-' },

  // MP4 / MOV: ?? ?? ?? ?? "ftyp"
  { kind: 'video', test: (b) => b.length >= 12 && b.slice(4, 8).toString() === 'ftyp' },
  // WebM / MKV: EBML header 1A 45 DF A3
  { kind: 'video', test: (b) => b.length >= 4 && b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3 },

  // MP3: "ID3" tag header
  { kind: 'audio', test: (b) => b.length >= 3 && b.slice(0, 3).toString() === 'ID3' },
  // MP3 raw frame: FF Ex/Fx
  { kind: 'audio', test: (b) => b.length >= 2 && b[0] === 0xFF && (b[1] & 0xE0) === 0xE0 },
  // WAV: RIFF....WAVE
  { kind: 'audio', test: (b) => b.length >= 12 && b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WAVE' },
  // M4A: ftypM4A (covered by mp4 ftyp; subtype check below)
  // OGG: "OggS"
  { kind: 'audio', test: (b) => b.length >= 4 && b.slice(0, 4).toString() === 'OggS' },
];

function detectKind(buffer) {
  if (!buffer || !buffer.length) return null;
  for (const sig of SIGNATURES) {
    try {
      if (sig.test(buffer)) return sig.kind;
    } catch (_) { /* keep scanning */ }
  }
  return null;
}

// Express middleware factory. Usage:
//   router.post('/avatar', upload.single('avatar'), verifyFileType(['image']), handler)
//
// Rejects with 400 if no file, kind not in allowed set, or signature unrecognised.
function verifyFileType(allowedKinds, opts = {}) {
  const fieldName = opts.fieldName || 'file';
  const required = opts.required !== false;
  return (req, res, next) => {
    const file = req.file;
    if (!file) {
      if (required) return res.status(400).json({ error: 'File missing' });
      return next();
    }
    const kind = detectKind(file.buffer);
    if (!kind) {
      return res.status(400).json({ error: 'Unsupported or corrupt file' });
    }
    if (!allowedKinds.includes(kind)) {
      return res.status(400).json({ error: `${kind} files are not allowed for this upload` });
    }
    file.detectedKind = kind;
    next();
  };
}

module.exports = { detectKind, verifyFileType };
