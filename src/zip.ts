// 可复现的无压缩ZIP，仅用于公开的扩展文件；不读取用户配对目录。
const table=Uint32Array.from({length:256},(_,value)=>{for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
const crc32=(bytes:Uint8Array)=>{let crc=0xffffffff;for(const value of bytes)crc=table[(crc^value)&255]!^(crc>>>8);return(crc^0xffffffff)>>>0;};
export function zipArchive(entries:[string,Buffer][]){
 const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const[name,bytes]of entries){if(!/^[a-zA-Z0-9_.-]+$/.test(name)||bytes.length>64*1024*1024)throw new Error('Invalid extension ZIP entry');const filename=Buffer.from(name),crc=crc32(bytes);
  const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(33,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(filename.length,26);
  local.push(header,filename,bytes);const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(33,14);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(bytes.length,20);directory.writeUInt32LE(bytes.length,24);directory.writeUInt16LE(filename.length,28);directory.writeUInt32LE(offset,42);central.push(directory,filename);offset+=header.length+filename.length+bytes.length;
 }
 const catalog=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(catalog.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,catalog,end]);
}
