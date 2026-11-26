const markdown=globalThis.markdownit({html:false,linkify:false,breaks:false});
markdown.use(globalThis.texmath,{
  engine:globalThis.katex,
  delimiters:['dollars','brackets','beg_end'],
  katexOptions:{trust:false,throwOnError:false,maxExpand:100,maxSize:18}
});

// Model-generated URLs and images are displayed as text. No remote assets load.
markdown.renderer.rules.link_open=()=>'<span>';
markdown.renderer.rules.link_close=()=>'</span>';
markdown.renderer.rules.image=(tokens,index)=>markdown.utils.escapeHtml(tokens[index].content);

const citations=/\[PDF[ \t]*[:：][ \t]*(\d+)[ \t]*\]|第\s*(\d+)\s*页|\b(?:page[ \t]+|p\.[ \t]*)(\d+)\b(?!\.\d)/gi;
export function renderAnswerMarkdown(container,text,pages=[],jumpToPage){
  const template=document.createElement('template');
  template.innerHTML=markdown.render(text);
  if(jumpToPage){
    const validPages=new Set(pages);
    const walker=document.createTreeWalker(template.content,NodeFilter.SHOW_TEXT);
    const nodes=[];
    while(walker.nextNode()){
      const node=walker.currentNode;
      if(!node.parentElement?.closest('pre,code,.katex,eq,eqn'))nodes.push(node);
    }
    for(const node of nodes){
      let end=0;
      const fragment=document.createDocumentFragment();
      for(const match of node.data.matchAll(citations)){
        const page=Number(match[1]??match[2]??match[3]);
        if(!validPages.has(page))continue;
        fragment.append(node.data.slice(end,match.index));
        const button=document.createElement('button');
        button.type='button';
        button.className='answer-citation';
        button.textContent=match[0];
        button.onclick=()=>jumpToPage(page);
        fragment.append(button);
        end=match.index+match[0].length;
      }
      if(end){
        fragment.append(node.data.slice(end));
        node.replaceWith(fragment);
      }
    }
  }
  for(const table of template.content.querySelectorAll('table')){
    const region=document.createElement('div');
    region.className='qa-table-scroll';
    region.tabIndex=0;
    region.setAttribute('role','region');
    region.setAttribute('aria-label','回答中的表格');
    table.replaceWith(region);
    region.append(table);
  }
  container.replaceChildren(template.content);
}