const fs=require('node:fs');
const path=require('node:path');

// Fail closed if the OS credential service is unavailable. Never fall back to
// a plaintext config in userData. Atomic replacement protects crash recovery.
module.exports=function secureStore(file,safeStorage) {
  function available(){if(!safeStorage.isEncryptionAvailable())throw Error('OS credential storage is unavailable');}
  return {
    read(){if(!fs.existsSync(file))return null;available();return JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));},
    write(value){available();fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=`${file}.tmp`;
      fs.writeFileSync(tmp,safeStorage.encryptString(JSON.stringify(value)),{mode:0o600});fs.renameSync(tmp,file);},
  };
};
