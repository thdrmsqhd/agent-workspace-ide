import type { ChangeBlock, DiffModel, RealLine } from "@awi/diff";
import { targetForBlock } from "@awi/diff";

export interface DiffViewOptions {
  readonly activeBlock?: number;
  readonly onSelectBlock?: (index:number, block:ChangeBlock)=>void;
}

function blockAt(model:DiffModel,side:"old"|"new",line:number):ChangeBlock|undefined{
  return model.blocks.find(block=>{
    const start=side==="old"?block.oldStart:block.newStart;
    const end=side==="old"?block.oldEnd:block.newEnd;
    return start===end ? line===start : line>=start&&line<end;
  });
}
function lineClass(block:ChangeBlock|undefined,side:"old"|"new"):string|undefined{
  if(!block)return undefined;
  if(block.kind==="insert")return side==="new"?"awi-insert":undefined;
  if(block.kind==="delete")return side==="old"?"awi-delete":undefined;
  return "awi-replace";
}
function lines(doc:Document,model:DiffModel,source:readonly RealLine[],side:"old"|"new"):HTMLOListElement{
  const list=doc.createElement("ol");list.className="awi-diff-lines";
  source.forEach((line,index)=>{
    const item=doc.createElement("li");item.dataset.line=String(index);
    const cls=lineClass(blockAt(model,side,index),side);if(cls)item.className=cls;
    item.textContent=line.text.length?line.text:" ";
    list.append(item);
  });
  return list;
}
function reveal(container:HTMLElement,line:number):void{
  const target=container.querySelector<HTMLElement>(`[data-line="${line}"]`);
  target?.scrollIntoView({block:"center",behavior:"smooth"});
}

/** 실제 파일 줄만 렌더링한다. 좌우 pane은 독립 scroll이며 연결 열은 변경 범위만 표현한다. */
export function renderDiffView(root:HTMLElement,model:DiffModel,options:DiffViewOptions={}):void{
  const doc=root.ownerDocument;
  const wrapper=doc.createElement("section");wrapper.className="awi-diff";
  const left=doc.createElement("div");left.className="awi-diff-pane";
  const right=doc.createElement("div");right.className="awi-diff-pane";
  left.append(lines(doc,model,model.oldLines,"old"));
  right.append(lines(doc,model,model.newLines,"new"));
  const links=doc.createElement("div");links.className="awi-diff-links";
  model.blocks.forEach((block,index)=>{
    const link=doc.createElement("button");link.type="button";link.className="awi-diff-link";
    link.textContent=`${index+1} · ${block.kind}`;
    link.title=`old ${block.oldStart+1}-${block.oldEnd} ↔ new ${block.newStart+1}-${block.newEnd}`;
    if(index===options.activeBlock)link.setAttribute("aria-current","true");
    link.addEventListener("click",()=>{
      const target=targetForBlock(model,index);
      reveal(left,target.leftLine);reveal(right,target.rightLine);
      options.onSelectBlock?.(index,block);
    });
    links.append(link);
  });
  wrapper.append(left,links,right);
  root.replaceChildren(wrapper);
}
