export function chunks(text, limit) {
  const parts=[];
  const encoder=new TextEncoder();
  let current='',size=0;
  for(const token of text.match(/[^\s。！？；]+[。！？；]*\s*|[。！？；]+\s*|\s+/gu)??[]){
    const bytes=encoder.encode(token).length;
    if(size+bytes>limit&&current.trim()){
      parts.push(current.trim());current='';size=0;
    }
    if(bytes<=limit){
      current+=token;size+=bytes;continue;
    }
    for(const char of token){
      const length=encoder.encode(char).length;
      if(size+length>limit){
        if(current.trim())parts.push(current.trim());
        current='';size=0;
      }
      current+=char;size+=length;
    }
  }
  if(current.trim())parts.push(current.trim());
  return parts;
}

export function joinSoftLines(text){
  return text.trim().replace(/([^\s])[^\S\n\r]*\r?\n[^\S\n\r]*(?=([^\s]))/gu,(line,left,right,offset,whole)=>{
    const next=whole.slice(offset+line.length);
    if(/^(?:[•▪●]|[-*]\s|\d{1,3}[.)、]\s|#{1,6}\s)/u.test(next))return line;
    const tight=/[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u;
    return left+(tight.test(left)||tight.test(right)?'':' ');
  });
}

export function joinTranslationParts(parts){
  return joinSoftLines(parts.map(part=>part.trim()).filter(Boolean).join('\n'));
}
