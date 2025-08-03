import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('Current __dirname:', __dirname);
console.log('Static path should be:', path.join(__dirname, "dist", "public"));
console.log('Files in that directory:');

const staticPath = path.join(__dirname, "dist", "public");
try {
  const files = fs.readdirSync(staticPath);
  console.log(files);
} catch (error) {
  console.log('Directory does not exist:', error.message);
}

// Also check if bundle.js exists
const bundlePath = path.join(staticPath, 'bundle.js');
console.log('Bundle.js exists:', fs.existsSync(bundlePath));