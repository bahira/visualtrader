import {rename,writeFile} from 'node:fs/promises';

export async function publishJson(path, value, onBusy=()=>{}) {
  const tmp = path+'.tmp';
  await writeFile(tmp,JSON.stringify(value,null,2));
  for (let i=0;i<6;i++) {
    try { await rename(tmp,path); return true; }
    catch (error) {
      if (!['EPERM','EACCES','EBUSY'].includes(error.code)) throw error;
      if (i===5) { onBusy(error); return false; }
      await new Promise(resolve=>setTimeout(resolve,20*(i+1)));
    }
  }
}
