import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const allowed=new Set(["PASS","FAIL","BLOCKED","NOT_RUN"]);
const records=[];
for(let i=1;i<=23;i++){
  const id=`AT-${String(i).padStart(2,"0")}`;
  try{
    const data=JSON.parse(await readFile(join("docs","evidence","acceptance",`${id}.json`),"utf8"));
    if(!allowed.has(data.status)) throw new Error(`${id} 상태가 잘못되었습니다.`);
    records.push({id,status:data.status,detail:data.detail??""});
  }catch(error){
    if(error.code==="ENOENT") records.push({id,status:"NOT_RUN",detail:"증거 파일 없음"});
    else throw error;
  }
}
const counts=Object.fromEntries([...allowed].map(status=>[status,records.filter(x=>x.status===status).length]));
process.stdout.write(JSON.stringify({counts,records},null,2)+"\n");
if(counts.FAIL>0) process.exitCode=1;
