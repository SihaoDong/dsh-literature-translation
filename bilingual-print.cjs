const {BrowserWindow}=require('electron');
const escapeHtml=text=>text.replace(/[&<>]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[char]));
async function printBilingual(pages){
  if(!Array.isArray(pages)||!pages.length||pages.some(page=>!page||!Number.isInteger(page.page)||page.page<1||typeof page.source!=='string'||typeof page.translation!=='string'))throw Error('没有可导出的全文译文。');
  const sections=pages.map(({page,source,translation,image,engineLabel})=>
    '<section><table><thead><tr><th colspan="2"><h2>第 '+page+' 页'+
    (typeof engineLabel==='string'&&engineLabel?' <small>'+escapeHtml(engineLabel)+'</small>':'')+
    '</h2></th></tr><tr><th>原文</th><th>译文</th></tr></thead><tbody><tr><td>'+
    (typeof image==='string'&&/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(image)?'<img alt="PDF 原页" src="'+image+'">':'<div>'+escapeHtml(source)+'</div>')+
    '</td><td><div>'+escapeHtml(translation)+'</div></td></tr></tbody></table></section>').join('');
  const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>'+
    '@page{size:A4;margin:15mm}body{font:11pt/1.55 "Microsoft YaHei",Arial,sans-serif;color:#182231;margin:0}'+
    'section+section{break-before:page}h2{font-size:15pt;margin:0 0 9pt}h2 small{color:#58645c;font-size:9pt;font-weight:400;overflow-wrap:anywhere}thead{display:table-header-group;break-inside:avoid}th{text-align:left;font-size:11pt;padding:0 9pt 7pt}th:first-child{padding-left:0}'+
    'table{width:100%;table-layout:fixed;border-collapse:collapse}td{width:50%;vertical-align:top;padding:0 9pt}'+
    'td:first-child{padding-left:0;border-right:1px solid #aeb9c8}td:last-child{padding-right:0}'+
    'td img{display:block;width:100%;height:auto;max-height:220mm;object-fit:contain;object-position:top left}td div{white-space:pre-wrap;overflow-wrap:anywhere}</style><body>'+sections+'</body></html>';
  const printWindow=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  try{
    await printWindow.loadURL('about:blank');
    await printWindow.webContents.executeJavaScript('document.open();document.write('+JSON.stringify(html)+');document.close();Promise.all([document.fonts.ready,...Array.from(document.images,img=>img.decode())]).then(()=>true);');
    return await printWindow.webContents.printToPDF({preferCSSPageSize:true,printBackground:true});
  }finally{if(!printWindow.isDestroyed())printWindow.destroy();}
}
module.exports={printBilingual};
