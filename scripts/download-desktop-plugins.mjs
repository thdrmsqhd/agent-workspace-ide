import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const root=fileURLToPath(new URL("../apps/desktop/",import.meta.url));
const manifest=JSON.parse(await readFile(join(root,"package.json"),"utf8"));
const plugins=manifest.theiaPlugins??{};
const target=join(root,"plugins");
await mkdir(target,{recursive:true});

for(const [id,url] of Object.entries(plugins)){
  if(typeof url!=="string"||!url.startsWith("https://open-vsx.org/"))throw new Error(`허용되지 않은 확장 URL: ${id}`);
  const response=await fetch(url,{redirect:"follow"});
  if(!response.ok)throw new Error(`${id} 다운로드 실패: HTTP ${response.status}`);
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.byteLength<1024)throw new Error(`${id} VSIX가 비정상적으로 작습니다: ${bytes.byteLength}`);
  const name=basename(new URL(url).pathname);
  const path=join(target,name);
  await writeFile(path,bytes);
  process.stdout.write(`${id}: ${name} (${bytes.byteLength} bytes)\n`);
}
