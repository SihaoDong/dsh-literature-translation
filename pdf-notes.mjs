async function loadPdfForEditing(bytes){
  await import('/pdf-lib.js');
  const {PDFDocument}=globalThis.PDFLib;
  try{return await PDFDocument.load(bytes);}
  catch(error){
    if(error.message?.startsWith('Input document to `PDFDocument.load` is encrypted.')){
      throw Error('当前 PDF 已加密，Dsh 无法将批注写入此文件。批注草稿仍保留在本机。');
    }
    throw error;
  }
}
export async function exportAnnotatedPdf(bytes, notes, originalFingerprint) {
  const pdf=await loadPdfForEditing(bytes);
  if(/^[0-9a-f]{32}$/i.test(originalFingerprint??'')){
    const {PDFArray,PDFHexString}=globalThis.PDFLib;
    const id=pdf.context.lookup(pdf.context.trailerInfo.ID);
    const first=id instanceof PDFArray?pdf.context.lookup(id.get(0))?.asBytes?.():undefined;
    if(first?.length!==16||!first.some(byte=>byte!==0)){
      const fingerprint=PDFHexString.of(originalFingerprint);
      pdf.context.trailerInfo.ID=pdf.context.obj([fingerprint,fingerprint]);
    }
  }
  await writeAnnotations(pdf,notes);
  return pdf.save();
}

function findAnnotation(pdf,page,note){
  const {PDFName,PDFArray,PDFDict,PDFRef}=globalThis.PDFLib;
  const match=/^(\d+)R(\d*)$/.exec(note.removeRef??note.editRef??note.styleRef);
  const fail=()=>Error('无法找到待修改的批注，请撤销后重新选择。');
  if(!match||note.removeRect?.length!==4||!note.removeRect.every(Number.isFinite))throw fail();
  const ref=PDFRef.of(Number(match[1]),Number(match[2]||0));
  const annotations=page.node.lookupMaybe(PDFName.of('Annots'),PDFArray);
  const index=annotations?.asArray().indexOf(ref)??-1;
  const object=pdf.context.lookup(ref);
  if(index<0||!(object instanceof PDFDict)||object.get(PDFName.of('Subtype'))?.asString?.()!=='/'+note.removeSubtype)throw fail();
  const rectangle=object.lookupMaybe(PDFName.of('Rect'),PDFArray)?.asRectangle();
  if(!rectangle)throw fail();
  const {x,y,width,height}=rectangle;
  const bounds=[Math.min(x,x+width),Math.min(y,y+height),Math.max(x,x+width),Math.max(y,y+height)];
  if(bounds.some((edge,index)=>Math.abs(edge-note.removeRect[index])>.02))throw fail();
  return {annotations,index,ref,object};
}

function unlinkAnnotation(pdf,page,note){
  const {PDFDict,PDFName}=globalThis.PDFLib;
  const {annotations,index,ref,object}=findAnnotation(pdf,page,note);
  annotations.remove(index);
  const popup=object.get(PDFName.of('Popup'));
  const popupObject=pdf.context.lookup(popup);
  if(popupObject instanceof PDFDict&&popupObject.get(PDFName.of('Subtype'))?.asString?.()==='/Popup'&&
     popupObject.get(PDFName.of('Parent'))===ref){
    const popupIndex=annotations.asArray().indexOf(popup);
    if(popupIndex>=0)annotations.remove(popupIndex);
  }
}
function lineAppearanceBounds(line,type,stroke){
  const [x1,y1,x2,y2]=line;
  const padding=type==='arrow'?Math.max(7,stroke*4):stroke;
  return [Math.min(x1,x2)-padding,Math.min(y1,y2)-padding,
    Math.max(x1,x2)+padding,Math.max(y1,y2)+padding];
}

async function writeAnnotations(pdf,notes){
  const {PDFName,PDFHexString,PDFArray,PDFString}=globalThis.PDFLib;
  const removedRefs=new Set(notes.map(note=>note.removeRef).filter(Boolean));
  const updatedBounds=[];
  for (const [index,note] of notes.entries()) {
    const page = pdf.getPage(note.page-1);
    if(note.cropBox){page.setCropBox(...note.cropBox);continue;}
    if(note.rotateBy!==undefined){rotatePage(page,note.rotateBy);continue;}
    if(note.removeRef){unlinkAnnotation(pdf,page,note);continue;}
    if(note.editRef){
      const {object}=findAnnotation(pdf,page,note);
      const contentKey=PDFName.of('Contents');
      if(note.removeSubtype==='FreeText'||object.has(PDFName.of('RC')))throw Error('此批注包含独立的页面文字或富文本。');
      object.set(contentKey,PDFHexString.fromText(note.text));
      continue;
    }
    if(note.styleRef){
      if(removedRefs.has(note.styleRef))continue;
      const {object}=findAnnotation(pdf,page,note);
      const shape={Square:'square',Circle:'circle',Line:'line'}[note.removeSubtype];
      const key=PDFName.of;
      const author=object.lookup(key('T'))?.decodeText?.();
      const {PDFDict}=globalThis.PDFLib;
      const flags=object.lookup(key('F'))?.asNumber?.()??0;
      const borderStyle=object.lookupMaybe(key('BS'),PDFDict);
      const style=borderStyle?.lookup(key('S'))?.asString?.();
      const legacyBorder=object.lookupMaybe(key('Border'),PDFArray);
      const own=author==='Dsh文献翻译';
      const standard=shape!=='line'&&!object.has(key('AP'))&&!object.has(key('BE'))&&
        !object.has(key('RD'))&&(!style||style==='/S')&&(!legacyBorder||legacyBorder.size()<=3);
      if(!shape||(flags&192)||(!own&&!standard)||!/^#[0-9a-f]{6}$/i.test(note.color)||
         ![1,2,4,6].includes(note.width))throw Error('无法修改此图形的外观。');
      const color=note.color.slice(1).match(/../g).map(hex=>parseInt(hex,16)/255);
      if(!own){
        if(Math.min(note.removeRect[2]-note.removeRect[0],note.removeRect[3]-note.removeRect[1])<=note.width){
          throw Error('线宽超出图形尺寸，请选择较细的线宽。');
        }
        object.set(key('C'),pdf.context.obj(color));
        object.set(key('BS'),pdf.context.obj({W:note.width,S:key('S')}));
        continue;
      }
      const line=shape==='line'?object.lookupMaybe(key('L'),PDFArray)?.asArray().map(value=>value.asNumber?.()):null;
      if(shape==='line'&&(line?.length!==4||!line.every(Number.isFinite)||
         (line[0]===line[2]&&line[1]===line[3])))throw Error('无法读取原图形的端点。');
      const endings=object.lookupMaybe(key('LE'),PDFArray);
      const type=endings?.get(1)?.asString?.()==='/ClosedArrow'?'arrow':shape;
      let rect=note.removeRect;
      if(line){
        const required=lineAppearanceBounds(line,type,note.width);
        rect=rect.map((edge,index)=>index<2?Math.min(edge,required[index]):Math.max(edge,required[index]));
        updatedBounds.push({object,rect});
      }
      const appearance=shapeAppearanceFor(pdf,rect,type,note.width,color,line);
      object.set(key('C'),pdf.context.obj(color));
      object.set(key('BS'),pdf.context.obj({W:note.width,S:key('S')}));
      object.set(key('AP'),pdf.context.obj({N:appearance}));
      continue;
    }
    const {x,y,width,height} = page.getCropBox();
    const left = x+Math.max(0,width-32-(index%6)*22);
    const top = y+Math.max(0,height-32-Math.floor(index/6)%10*22);
    const quads=note.quads?.flat();
    const xs=quads?.filter((_,index)=>index%2===0), ys=quads?.filter((_,index)=>index%2!==0);
    const shapeWidth=Number.isFinite(note.shapeWidth)?Math.max(1,Math.min(8,note.shapeWidth)):2;
    const shapeColor=/^#[0-9a-f]{6}$/i.test(note.shapeColor??'')?
      note.shapeColor.slice(1).match(/../g).map(hex=>parseInt(hex,16)/255):[.12,.33,.68];
    const line=note.shapeLine;
    const lineRect=line?lineAppearanceBounds(line,note.shapeType,shapeWidth):null;
    const rect=note.freeText??note.shapeRect??note.pointRect??lineRect??(quads?.length?[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)]:[left,top,left+20,top+20]);
    const subtype=note.freeText?'FreeText':note.shapeRect?(note.shapeType==='circle'?'Circle':'Square'):line?'Line':quads?.length?(['Underline','StrikeOut','Squiggly'].includes(note.markup)?note.markup:'Highlight'):'Text';
    const textAppearance=note.freeText?await typewriterAppearance(pdf,note.text,rect):null;
    const shapeAppearance=note.shapeRect||line?shapeAppearanceFor(pdf,rect,note.shapeType,shapeWidth,shapeColor,line):null;
    const annotation = pdf.context.obj({
      Type:PDFName.of('Annot'),Subtype:PDFName.of(subtype),Rect:rect,
      Contents:PDFHexString.fromText(note.translation?note.text+'\n\n译文\n'+note.translation:note.text),T:PDFHexString.fromText('Dsh文献翻译'),
      ...(textAppearance?{DA:PDFString.of('/Helv 12 Tf 0 g'),AP:{N:textAppearance},Border:[0,0,0]}:shapeAppearance?{C:shapeColor,BS:{W:shapeWidth,S:PDFName.of('S')},AP:{N:shapeAppearance},...(line?{L:line,LE:[PDFName.of('None'),PDFName.of(note.shapeType==='arrow'?'ClosedArrow':'None')]}:{})}:quads?.length?{QuadPoints:quads,C:subtype==='Highlight'?[1,.85,.1]:[.12,.33,.68]}:{Name:PDFName.of('Comment'),Open:false,...(note.pointRect?{C:[1,.85,.1],AP:{N:pointNoteAppearance(pdf)}}:{})}),F:4,P:page.ref
    });
    const key = PDFName.of('Annots');
    let annotations = page.node.lookupMaybe(key,PDFArray);
    if (!annotations) {
      annotations=pdf.context.obj([]);
      page.node.set(key,annotations);
    }
    const duplicate=subtype==='Text'&&annotations.asArray().some(ref=>{
      const existing=pdf.context.lookup(ref);
      const existingRect=existing?.lookupMaybe?.(PDFName.of('Rect'),PDFArray);
      const samePlacement=note.pointRect?
        existingRect?.size()===4&&rect.every((edge,i)=>Math.abs(existingRect.lookup(i)?.asNumber?.()-edge)<.02):
        !existing?.has?.(PDFName.of('C'));
      return samePlacement &&
        existing?.get?.(PDFName.of('Subtype'))?.asString?.()==='/Text' &&
        existing?.get?.(PDFName.of('T'))?.decodeText?.()==='Dsh文献翻译' &&
        existing?.get?.(PDFName.of('Contents'))?.decodeText?.()===note.text;
    });
    if(duplicate)continue;
    const annotationRef=pdf.context.register(annotation);
    annotations.push(annotationRef);
    if(note.pointRect){
      const popupWidth=Math.min(200,width),popupHeight=Math.min(100,height);
      const popupLeft=Math.max(x,Math.min(rect[2]+8,x+width-popupWidth));
      const popupBottom=Math.max(y,Math.min(rect[3]-popupHeight,y+height-popupHeight));
      const popup=pdf.context.register(pdf.context.obj({Type:PDFName.of('Annot'),Subtype:PDFName.of('Popup'),
        P:page.ref,Parent:annotationRef,Open:false,Rect:[popupLeft,popupBottom,popupLeft+popupWidth,popupBottom+popupHeight]}));
      annotation.set(PDFName.of('Popup'),popup);
      annotations.push(popup);
    }
  }
  for(const {object,rect} of updatedBounds)object.set(PDFName.of('Rect'),pdf.context.obj(rect));
}

function cropEdits(pdf,{first,last,subset,margins}){
  const {PDFName}=globalThis.PDFLib;
  const pageCount=pdf.getPageCount();
  if(!Number.isInteger(first)||!Number.isInteger(last)||first<1||last<first||last>pageCount||
     !['all','odd','even'].includes(subset)||margins.length!==4||
     !margins.every(value=>Number.isFinite(value)&&value>=0))throw Error('请输入有效的页码和裁剪边距。');
  const boxes=[];
  for(let number=first;number<=last;number++){
    if(subset==='odd'&&number%2===0||subset==='even'&&number%2===1)continue;
    const page=pdf.getPage(number-1);
    const {x,y,width,height}=page.getCropBox();
    const angle=((page.getRotation().angle%360)+360)%360;
    const turn=angle/90;
    if(!Number.isInteger(turn))throw Error('第 '+number+' 页的旋转角度无法裁剪。');
    const userUnit=page.node.lookup(PDFName.of('UserUnit'))?.asNumber?.()||1;
    const [top,right,bottom,left]=margins.map((_,i)=>margins[(i+turn)%4]*72/(2.54*userUnit));
    if(width-left-right<=0||height-top-bottom<=0)throw Error('第 '+number+' 页的裁剪边距超过页面大小。');
    boxes.push({page:number,cropBox:[x+left,y+bottom,width-left-right,height-top-bottom]});
  }
  if(!boxes.length)throw Error('范围内没有符合条件的页面。');
  return boxes;
}

export async function getPdfCropEdits(bytes,options){
  return cropEdits(await loadPdfForEditing(bytes),options);
}

export async function cropPdfPages(bytes,options,notes=[]){
  const pdf=await loadPdfForEditing(bytes);
  const edits=cropEdits(pdf,options);
  await writeAnnotations(pdf,[...notes,...edits]);
  return pdf.save();
}

function rotatePage(page,quarterTurn){
  const {degrees}=globalThis.PDFLib;
  if(![-90,90,180].includes(quarterTurn))throw Error('无效的旋转角度。');
  const angle=page.getRotation().angle;
  page.setRotation(degrees(((angle+quarterTurn)%360+360)%360));
}

export async function rotatePdfPages(bytes,ranges,quarterTurn,notes=[]){
  const pdf=await loadPdfForEditing(bytes);
  const selected=parsePageRanges(ranges,pdf.getPageCount());
  for(const index of selected)rotatePage(pdf.getPage(index),quarterTurn);
  await writeAnnotations(pdf,notes);
  return pdf.save();
}

export async function insertBlankPdfPages(bytes,{pageNumber,before,count},notes=[]){
  const pdf=await loadPdfForEditing(bytes);
  const anchor=pdf.getPages()[pageNumber-1];
  if(!anchor||!Number.isInteger(count)||count<1||count>1000)throw Error('请输入有效页码和插入页数。');
  await writeAnnotations(pdf,notes);
  const media=anchor.getMediaBox(),crop=anchor.getCropBox(),rotation=anchor.getRotation();
  const index=before?pageNumber-1:pageNumber;
  for(let offset=0;offset<count;offset++){
    const blank=pdf.insertPage(index+offset,[media.width,media.height]);
    blank.setMediaBox(media.x,media.y,media.width,media.height);
    blank.setCropBox(crop.x,crop.y,crop.width,crop.height);
    blank.setRotation(rotation);
  }
  return pdf.save();
}

export async function transferPdfPages(bytes,insertedBytes,{pageNumber,before,ranges,replace=false},notes=[]){
  const pdf=await loadPdfForEditing(bytes);
  if(!pdf.getPages()[pageNumber-1])throw Error('请输入有效参考页码。');
  const source=await loadPdfForEditing(insertedBytes);
  const count=source.getPageCount();
  if(!count)throw Error('插入的 PDF 没有页面。');
  const selected=ranges.trim()?[...parsePageRanges(ranges,count)]:Array.from({length:count},(_,index)=>index);
  const first=pageNumber-1;
  const replaced=replace?pdf.getPages().slice(first,first+selected.length):[];
  if(replace&&replaced.length!==selected.length)throw Error('选定的来源页超出了可替换的目标页范围。');
  await writeAnnotations(pdf,replace?notes.filter(note=>note.page<pageNumber||note.page>=pageNumber+selected.length):notes);
  const refs=new Map(selected.map((index,position)=>[source.getPage(index).ref.toString(),position]));
  const copied=await copySelectedPages(pdf,source,selected,refs,readNamedDestinations(source),replace?replaced.map(page=>page.ref):undefined);
  if(replace){
    const {PDFName}=globalThis.PDFLib;
    const parent=PDFName.of('Parent');
    copied.forEach((page,i)=>{
      // Preserve the original reference used by the page tree and document destinations.
      page.node.set(parent,replaced[i].node.get(parent));
      pdf.context.assign(replaced[i].ref,page.node);
      pdf.context.delete(page.ref);
    });
  }else{
    const index=before?first:pageNumber;
    copied.forEach((page,offset)=>pdf.insertPage(index+offset,page));
  }
  return pdf.save();
}

export function parsePageRanges(ranges,count){
  const pages=new Set();
  for (const part of ranges.trim().split(/[,，]/)) {
    const match = /^(\d+)\s*(?:[-–]\s*(\d+))?$/.exec(part.trim());
    const start = Number(match?.[1]), end = Number(match?.[2] ?? match?.[1]);
    if (!(start >= 1 && end >= start && end <= count)) throw Error('请输入有效页码，例如 1,3-5。');
    for (let page=start;page<=end;page++) pages.add(page-1);
  }
  return pages;
}

export async function extractPdfPages(bytes,ranges,notes=[]){
  const source=await loadPdfForEditing(bytes);
  return exportSelectedPages(source,parsePageRanges(ranges,source.getPageCount()),notes);
}

export async function exportPdfWithoutPages(bytes,ranges,notes=[]){
  const source=await loadPdfForEditing(bytes);
  const count=source.getPageCount();
  const excluded=parsePageRanges(ranges,count);
  if(excluded.size===count)throw Error('请至少保留一页。');
  const included=new Set();
  for(let index=0;index<count;index++)if(!excluded.has(index))included.add(index);
  return exportSelectedPages(source,included,notes);
}

async function exportSelectedPages(source,pages,notes){
  const {PDFDocument}=globalThis.PDFLib;
  await writeAnnotations(source,notes.filter(note=>pages.has(note.page-1)));
  const selectedPages=[...pages];
  const pageRefs=new Map(selectedPages.map((index,position)=>[source.getPage(index).ref.toString(),position]));
  const namedDestinations=readNamedDestinations(source);
  const outline=readSelectedOutline(source,pageRefs,namedDestinations);
  const output=await PDFDocument.create();
  const copied=await copySelectedPages(output,source,selectedPages,pageRefs,namedDestinations);
  copied.forEach(page=>output.addPage(page));
  writeSelectedOutline(output,copied,outline);
  return output.save();
}

async function copySelectedPages(output,source,selectedPages,pageRefs,namedDestinations,destinationRefs){
  const {PDFName,PDFArray,PDFDict}=globalThis.PDFLib;
  const annotationsKey=PDFName.of('Annots'),pageKey=PDFName.of('P');
  const annotationsOn=page=>page.node.lookupMaybe(annotationsKey,PDFArray)?.asArray()??[];
  const links=selectedPages.map(index=>preparePageLinks(source,source.getPage(index),pageRefs,namedDestinations));
  // Detach page backlinks before copying, otherwise the copier clones the page twice.
  const backlinks=selectedPages.map(index=>{
    const positions=[];
    annotationsOn(source.getPage(index)).forEach((ref,position)=>{
      const annotation=source.context.lookup(ref);
      if(annotation instanceof PDFDict&&annotation.has(pageKey)){
        positions.push(position);
        annotation.delete(pageKey);
      }
    });
    return positions;
  });
  const copied=await output.copyPages(source,selectedPages);
  const targets=destinationRefs??copied.map(page=>page.ref);
  for(const [index,page] of copied.entries()){
    const annotations=annotationsOn(page);
    for(const position of backlinks[index]){
      const annotation=output.context.lookup(annotations[position]);
      if(annotation instanceof PDFDict)annotation.set(pageKey,targets[index]);
    }
    for(const {position,action,destination,target} of links[index]){
      const annotation=output.context.lookup(annotations[position]);
      const owner=action?annotation.lookup(action,PDFDict):annotation;
      owner.lookup(destination,PDFArray).insert(0,targets[target]);
    }
  }
  return copied;
}

function readSelectedOutline(pdf,pageRefs,namedDestinations){
  const {PDFName,PDFArray,PDFDict,PDFNumber,PDFNull}=globalThis.PDFLib;
  const key=PDFName.of;
  const root=pdf.catalog.lookup(key('Outlines'));
  if(!(root instanceof PDFDict))return [];
  const visited=new Set();
  function readSiblings(first,depth){
    const entries=[];
    for(let item=first;item instanceof PDFDict&&!visited.has(item);item=item.lookup(key('Next'))){
      visited.add(item);
      const title=item.lookup(key('Title'))?.decodeText?.();
      const children=depth<128?readSiblings(item.lookup(key('First')),depth+1):[];
      const action=item.lookup(key('A'));
      const destination=item.lookup(key('Dest'))??(action instanceof PDFDict&&action.lookup(key('S'))?.asString?.()==='/GoTo'?action.lookup(key('D')):null);
      const array=destination instanceof PDFArray?destination:namedDestinations.get(destination?.decodeText?.());
      const firstValue=array?.get(0);
      const target=pageRefs.get(firstValue?.toString());
      const view=array?.asArray().slice(1).map(value=>pdf.context.lookup(value));
      const valid=target!==undefined&&view?.[0] instanceof PDFName&&
        view.slice(1).every(value=>value instanceof PDFNumber||value===PDFNull);
      if(title&&(valid||children.length)){
        entries.push({title,children,expanded:(item.lookup(key('Count'))?.asNumber?.()??0)>=0,
          destination:valid?{target,view}:null});
      }else if(!title)entries.push(...children);
    }
    return entries;
  }
  return readSiblings(root.lookup(key('First')),0);
}

function writeSelectedOutline(pdf,pages,outline){
  if(!outline.length)return;
  const {PDFName,PDFHexString}=globalThis.PDFLib;
  const key=PDFName.of;
  const root=pdf.context.obj({Type:key('Outlines')});
  const rootRef=pdf.context.register(root);
  function writeSiblings(parent,parentRef,entries){
    const objects=entries.map(()=>pdf.context.obj({Parent:parentRef}));
    const refs=objects.map(object=>pdf.context.register(object));
    let visible=entries.length;
    entries.forEach(({title,children,expanded,destination},index)=>{
      const item=objects[index];
      item.set(key('Title'),PDFHexString.fromText(title));
      if(index>0)item.set(key('Prev'),refs[index-1]);
      if(index+1<refs.length)item.set(key('Next'),refs[index+1]);
      if(destination)item.set(key('Dest'),pdf.context.obj([pages[destination.target].ref,...destination.view]));
      if(children.length){
        const count=writeSiblings(item,refs[index],children);
        item.set(key('Count'),pdf.context.obj(expanded?count:-count));
        if(expanded)visible+=count;
      }
    });
    parent.set(key('First'),refs[0]);
    parent.set(key('Last'),refs[refs.length-1]);
    return visible;
  }
  root.set(key('Count'),pdf.context.obj(writeSiblings(root,rootRef,outline)));
  pdf.catalog.set(key('Outlines'),rootRef);
}

function preparePageLinks(pdf,page,pageRefs,namedDestinations){
  const {PDFName,PDFArray,PDFDict}=globalThis.PDFLib;
  const annotations=page.node.lookupMaybe(PDFName.of('Annots'),PDFArray);
  const actionKey=PDFName.of('A'),directKey=PDFName.of('Dest'),gotoKey=PDFName.of('D');
  const kindKey=PDFName.of('S'),typeKey=PDFName.of('Subtype');
  const links=[];
  if(!annotations)return links;
  for(let position=0;position<annotations.size();){
    const annotation=pdf.context.lookup(annotations.get(position));
    if(!(annotation instanceof PDFDict)||annotation.get(typeKey)?.asString?.()!=='/Link'){
      position++;
      continue;
    }
    const action=annotation.lookup(actionKey);
    const direct=annotation.has(directKey);
    const isGoto=action instanceof PDFDict&&action.get(kindKey)?.asString?.()==='/GoTo';
    if(!direct&&!isGoto){
      position++;
      continue;
    }
    const destination=direct?directKey:gotoKey;
    const owner=direct?annotation:action.clone();
    const value=owner.lookup(destination);
    const array=value instanceof PDFArray?value:namedDestinations.get(value?.decodeText?.());
    const target=array instanceof PDFArray?pageRefs.get(array.get(0)?.toString()):undefined;
    if(target===undefined){
      annotations.remove(position);
      continue;
    }
    owner.set(destination,pdf.context.obj(array.asArray().slice(1)));
    if(!direct)annotation.set(actionKey,owner);
    links.push({position,action:direct?null:actionKey,destination,target});
    position++;
  }
  return links;
}

function readNamedDestinations(pdf){
  const {PDFName,PDFArray,PDFDict}=globalThis.PDFLib;
  const destsKey=PDFName.of('Dests'),arrayKey=PDFName.of('D');
  const namesKey=PDFName.of('Names'),kidsKey=PDFName.of('Kids');
  const destinations=new Map();
  const add=(name,ref)=>{
    if(typeof name!=='string')return;
    const value=pdf.context.lookup(ref);
    const array=value instanceof PDFDict?value.lookup(arrayKey):value;
    if(array instanceof PDFArray)destinations.set(name,array);
  };
  const legacy=pdf.catalog.lookup(destsKey);
  if(legacy instanceof PDFDict){
    for(const [name,value] of legacy.entries())add(name.decodeText(),value);
  }
  const names=pdf.catalog.lookup(namesKey);
  const stack=names instanceof PDFDict?[names.lookup(destsKey)]:[];
  const visited=new Set();
  while(stack.length){
    const node=pdf.context.lookup(stack.pop());
    if(!(node instanceof PDFDict)||visited.has(node))continue;
    visited.add(node);
    const pairs=node.lookup(namesKey);
    if(pairs instanceof PDFArray){
      for(let i=0;i+1<pairs.size();i+=2)add(pairs.lookup(i)?.decodeText?.(),pairs.get(i+1));
    }
    const children=node.lookup(kidsKey);
    if(children instanceof PDFArray)stack.push(...children.asArray());
  }
  return destinations;
}

function pointNoteAppearance(pdf){
  const icon='q 1 .85 .1 rg .32 .25 .1 RG 1 w 1 1 16 16 re B 4 13 m 14 13 l 4 9 m 14 9 l 4 5 m 11 5 l S Q';
  return pdf.context.register(pdf.context.flateStream(icon,{Type:'XObject',Subtype:'Form',BBox:[0,0,18,18]}));
}

function shapeAppearanceFor(pdf,rect,type,stroke,color,line){
  const width=rect[2]-rect[0],height=rect[3]-rect[1];
  const format=values=>values.map(value=>value.toFixed(4)).join(' ');
  const rgb=format(color);
  let drawing;
  if(line){
    const x1=line[0]-rect[0],y1=line[1]-rect[1],x2=line[2]-rect[0],y2=line[3]-rect[1];
    drawing=format([x1,y1])+' m '+format([x2,y2])+' l S';
    if(type==='arrow'){
      const length=Math.hypot(x2-x1,y2-y1),ux=(x2-x1)/length,uy=(y2-y1)/length;
      const head=Math.min(length,Math.max(7,stroke*4)),half=head*.42;
      const baseX=x2-ux*head,baseY=y2-uy*head;
      const shaftX=x2-ux*head*.65,shaftY=y2-uy*head*.65;
      drawing=format([x1,y1])+' m '+format([shaftX,shaftY])+' l S '+format([x2,y2])+' m '+
        format([baseX-uy*half,baseY+ux*half])+' l '+
        format([baseX+uy*half,baseY-ux*half])+' l h f';
    }
  }else{
    stroke=Math.min(stroke,width/2,height/2);
    const inset=stroke/2;
    if(type==='circle'){
      const cx=width/2,cy=height/2,rx=cx-inset,ry=cy-inset,k=.5522847498;
      drawing=format([cx+rx,cy])+' m '+[
        [cx+rx,cy+k*ry,cx+k*rx,cy+ry,cx,cy+ry],
        [cx-k*rx,cy+ry,cx-rx,cy+k*ry,cx-rx,cy],
        [cx-rx,cy-k*ry,cx-k*rx,cy-ry,cx,cy-ry],
        [cx+k*rx,cy-ry,cx+rx,cy-k*ry,cx+rx,cy]
      ].map(curve=>format(curve)+' c').join(' ')+' h S';
    }else drawing=format([inset,inset,width-stroke,height-stroke])+' re S';
  }
  const stream='q '+rgb+' RG '+rgb+' rg '+stroke.toFixed(4)+' w '+drawing+' Q';
  return pdf.context.register(pdf.context.flateStream(stream,{Type:'XObject',Subtype:'Form',BBox:[0,0,width,height]}));
}

async function typewriterAppearance(pdf,text,rect){
  const width=rect[2]-rect[0],height=rect[3]-rect[1];
  const canvas=document.createElement('canvas');
  canvas.width=Math.ceil(width*3);canvas.height=Math.ceil(height*3);
  const context=canvas.getContext('2d');
  context.scale(3,3);
  context.font='12px "Microsoft YaHei", sans-serif';
  context.fillStyle='#172d32';
  context.textBaseline='middle';
  context.fillText(text,2,height/2,width-4);
  const image=await pdf.embedPng(canvas.toDataURL('image/png'));
  return pdf.context.register(pdf.context.flateStream('q '+width+' 0 0 '+height+' 0 0 cm /Typed Do Q',{
    Type:'XObject',Subtype:'Form',BBox:[0,0,width,height],Resources:{XObject:{Typed:image.ref}}
  }));
}
