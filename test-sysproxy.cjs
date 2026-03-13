const path = require('path');
const fs = require('fs');

console.log('Testing sysproxy load...');
try {
  // Use 'extra/sidecar' as consistent with previous attempts
  const bindingPath = path.join(process.cwd(), 'extra/sidecar/sysproxy.win32-x64-msvc.node');
  console.log('Loading:', bindingPath);
  
  if (!fs.existsSync(bindingPath)) {
      console.error('File does not exist at path!');
      const dir = path.dirname(bindingPath);
      console.log('Contents of ' + dir + ':');
      try {
        console.log(fs.readdirSync(dir));
      } catch (e) {
        console.log('(Cannot read directory)');
      }
  } else {
      const binding = require(bindingPath);
      console.log('Success!');
      console.log('Exports:', Object.keys(binding));
  }
} catch (e) {
  console.error('Failed to load:', e);
}

// Keep it alive briefly
setTimeout(() => {
  console.log('Exiting...');
  process.exit(0);
}, 1000);
