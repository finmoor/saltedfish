// no-cors 不读响应也不带 Origin，只判断这个地址能不能连上。
export async function reachable(address:string){
  try{await fetch(address+'/health',{mode:'no-cors',cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(4000)});return true;}
  catch{return false;}
}
