(function () {
  const imageCache = new Map();

  function hexToRgb(hex) {
    const h = String(hex || '').replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return { r: 160, g: 160, b: 160 };
    return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) };
  }
  function rgbToHex(r,g,b) {
    return '#' + [r,g,b].map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('').toUpperCase();
  }
  function rgbToLab({r,g,b}) {
    let R=r/255,G=g/255,B=b/255;
    R=R>.04045?Math.pow((R+.055)/1.055,2.4):R/12.92;
    G=G>.04045?Math.pow((G+.055)/1.055,2.4):G/12.92;
    B=B>.04045?Math.pow((B+.055)/1.055,2.4):B/12.92;
    let x=(R*.4124+G*.3576+B*.1805)/.95047,y=(R*.2126+G*.7152+B*.0722),z=(R*.0193+G*.1192+B*.9505)/1.08883;
    const f=v=>v>.008856?Math.pow(v,1/3):(7.787*v)+16/116;
    x=f(x);y=f(y);z=f(z);
    return {L:116*y-16,a:500*(x-y),b:200*(y-z)};
  }
  function deltaE76(a,b){return Math.sqrt((a.L-b.L)**2+(a.a-b.a)**2+(a.b-b.b)**2);}
  function loadImage(src) {
    if (imageCache.has(src)) return imageCache.get(src);
    const promise = new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('Impossible de charger le logo.'));img.src=src;});
    imageCache.set(src,promise);return promise;
  }
  function packMask(mask){
    const bytes=new Uint8Array(Math.ceil(mask.length/8));
    for(let i=0;i<mask.length;i++)if(mask[i])bytes[i>>3]|=(1<<(i&7));
    let binary='';const chunk=0x8000;
    for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));
    return btoa(binary);
  }
  function unpackMask(base64,count){
    const bin=atob(String(base64||''));const bytes=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
    const mask=new Uint8Array(count);
    for(let i=0;i<count;i++)mask[i]=(bytes[i>>3]>>(i&7))&1;
    return mask;
  }

  async function create(canvas,src,targetHex,tolerance=42){
    const img=await loadImage(src);const maxW=760,maxH=390,scale=Math.min(maxW/img.naturalWidth,maxH/img.naturalHeight,1);
    const w=Math.max(1,Math.round(img.naturalWidth*scale)),h=Math.max(1,Math.round(img.naturalHeight*scale));canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.clearRect(0,0,w,h);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(img,0,0,w,h);
    const original=ctx.getImageData(0,0,w,h);let mask=new Uint8Array(w*h),currentTarget=targetHex,currentTolerance=Number(tolerance)||42;
    function rebuildMask(nextTarget=currentTarget,nextTolerance=currentTolerance){
      currentTarget=nextTarget;currentTolerance=Math.max(3,Math.min(100,Number(nextTolerance)||42));const targetLab=rgbToLab(hexToRgb(currentTarget));mask=new Uint8Array(w*h);const d=original.data;
      for(let i=0,p=0;i<d.length;i+=4,p++){if(d[i+3]<20)continue;const lab=rgbToLab({r:d[i],g:d[i+1],b:d[i+2]});if(deltaE76(lab,targetLab)<=currentTolerance)mask[p]=1;}
    }
    function render(replacementHex=null){const out=new ImageData(new Uint8ClampedArray(original.data),w,h),repl=replacementHex?hexToRgb(replacementHex):{r:166,g:166,b:166},d=out.data;for(let i=0,p=0;i<d.length;i+=4,p++){if(!mask[p])continue;d[i]=repl.r;d[i+1]=repl.g;d[i+2]=repl.b;}ctx.putImageData(out,0,0);}
    function renderOriginal(){ctx.putImageData(original,0,0);}
    function sampleAtEvent(evt){const rect=canvas.getBoundingClientRect(),x=Math.max(0,Math.min(w-1,Math.floor((evt.clientX-rect.left)*w/rect.width))),y=Math.max(0,Math.min(h-1,Math.floor((evt.clientY-rect.top)*h/rect.height))),i=(y*w+x)*4,d=original.data;if(d[i+3]<20)return null;return rgbToHex(d[i],d[i+1],d[i+2]);}
    function maskStats(){let count=0,opaque=0;for(let p=0,i=0;p<mask.length;p++,i+=4){if(original.data[i+3]>=20)opaque++;if(mask[p])count++;}return {matchedPixels:count,totalPixels:opaque,ratio:opaque?count/opaque:0};}
    function secureAssets(){
      render(null);
      return {playImage:canvas.toDataURL('image/png'),maskBits:packMask(mask),maskWidth:w,maskHeight:h,secureAssetsVersion:1};
    }
    rebuildMask(targetHex,tolerance);render(null);
    return {render,renderOriginal,rebuildMask,sampleAtEvent,maskStats,secureAssets,width:w,height:h};
  }

  async function createSecure(canvas,playImage,maskBits,maskWidth,maskHeight){
    const img=await loadImage(playImage);const w=Number(maskWidth)||img.naturalWidth,h=Number(maskHeight)||img.naturalHeight;
    canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.clearRect(0,0,w,h);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(img,0,0,w,h);
    const masked=ctx.getImageData(0,0,w,h),mask=unpackMask(maskBits,w*h);
    function render(replacementHex=null){const out=new ImageData(new Uint8ClampedArray(masked.data),w,h);if(replacementHex){const repl=hexToRgb(replacementHex),d=out.data;for(let i=0,p=0;i<d.length;i+=4,p++){if(!mask[p])continue;d[i]=repl.r;d[i+1]=repl.g;d[i+2]=repl.b;}}ctx.putImageData(out,0,0);}
    render(null);return {render,width:w,height:h};
  }

  window.LogoTone={create,createSecure};
})();
