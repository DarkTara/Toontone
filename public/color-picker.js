(function(){
  function clamp(v,min=0,max=1){return Math.max(min,Math.min(max,v));}
  function hsvToRgb(h,s,v){
    h=((h%360)+360)%360;const c=v*s,x=c*(1-Math.abs((h/60)%2-1)),m=v-c;let r=0,g=0,b=0;
    if(h<60){r=c;g=x}else if(h<120){r=x;g=c}else if(h<180){g=c;b=x}else if(h<240){g=x;b=c}else if(h<300){r=x;b=c}else{r=c;b=x}
    return {r:Math.round((r+m)*255),g:Math.round((g+m)*255),b:Math.round((b+m)*255)};
  }
  function rgbToHsv(r,g,b){
    r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0;
    if(d){if(max===r)h=60*(((g-b)/d)%6);else if(max===g)h=60*((b-r)/d+2);else h=60*((r-g)/d+4);}if(h<0)h+=360;
    return {h,s:max?d/max:0,v:max};
  }
  function rgbToHex({r,g,b}){return '#'+[r,g,b].map(v=>Math.round(v).toString(16).padStart(2,'0')).join('').toUpperCase();}
  function hexToRgb(hex){const m=/^#?([0-9a-f]{6})$/i.exec(String(hex||''));if(!m)return null;const h=m[1];return {r:parseInt(h.slice(0,2),16),g:parseInt(h.slice(2,4),16),b:parseInt(h.slice(4,6),16)};}

  function create(canvas, opts={}){
    const ctx=canvas.getContext('2d');
    const size=260,dpr=Math.max(1,Math.min(2,window.devicePixelRatio||1));
    canvas.width=size*dpr;canvas.height=size*dpr;canvas.style.width=size+'px';canvas.style.height=size+'px';ctx.scale(dpr,dpr);
    const C=size/2,outer=124,inner=92,sq=118,left=C-sq/2,top=C-sq/2;
    let hsv={h:0,s:0,v:.65},drag=null,onChange=typeof opts.onChange==='function'?opts.onChange:()=>{};

    function draw(){
      ctx.clearRect(0,0,size,size);
      ctx.save();ctx.lineWidth=outer-inner;ctx.lineCap='butt';
      const rr=(outer+inner)/2;
      for(let a=0;a<360;a+=2){ctx.beginPath();ctx.strokeStyle=`hsl(${a} 100% 50%)`;ctx.arc(C,C,rr,(a-1)*Math.PI/180,(a+2)*Math.PI/180);ctx.stroke();}
      ctx.restore();
      ctx.save();ctx.shadowColor='rgba(0,0,0,.18)';ctx.shadowBlur=9;ctx.fillStyle=`hsl(${hsv.h} 100% 50%)`;ctx.fillRect(left,top,sq,sq);ctx.shadowBlur=0;
      let g=ctx.createLinearGradient(left,0,left+sq,0);g.addColorStop(0,'#fff');g.addColorStop(1,'rgba(255,255,255,0)');ctx.fillStyle=g;ctx.fillRect(left,top,sq,sq);
      g=ctx.createLinearGradient(0,top,0,top+sq);g.addColorStop(0,'rgba(0,0,0,0)');g.addColorStop(1,'#000');ctx.fillStyle=g;ctx.fillRect(left,top,sq,sq);ctx.restore();
      // hue marker
      const ang=hsv.h*Math.PI/180,hx=C+rr*Math.cos(ang),hy=C+rr*Math.sin(ang);
      ctx.beginPath();ctx.arc(hx,hy,7,0,Math.PI*2);ctx.lineWidth=3;ctx.strokeStyle='#fff';ctx.stroke();ctx.beginPath();ctx.arc(hx,hy,8.5,0,Math.PI*2);ctx.lineWidth=1.5;ctx.strokeStyle='#111';ctx.stroke();
      // SV marker
      const sx=left+hsv.s*sq,sy=top+(1-hsv.v)*sq;ctx.beginPath();ctx.arc(sx,sy,7,0,Math.PI*2);ctx.lineWidth=3;ctx.strokeStyle='#fff';ctx.stroke();ctx.beginPath();ctx.arc(sx,sy,8.5,0,Math.PI*2);ctx.lineWidth=1.5;ctx.strokeStyle='#111';ctx.stroke();
    }
    function value(){return rgbToHex(hsvToRgb(hsv.h,hsv.s,hsv.v));}
    function emit(){draw();onChange(value(),{...hsv});}
    function coords(e){const r=canvas.getBoundingClientRect();return {x:(e.clientX-r.left)*size/r.width,y:(e.clientY-r.top)*size/r.height};}
    function chooseMode(p){const dx=p.x-C,dy=p.y-C,d=Math.hypot(dx,dy);if(d>=inner-8&&d<=outer+10)return 'hue';if(p.x>=left-8&&p.x<=left+sq+8&&p.y>=top-8&&p.y<=top+sq+8)return 'sv';return null;}
    function update(p,mode){
      if(mode==='hue'){let deg=Math.atan2(p.y-C,p.x-C)*180/Math.PI;if(deg<0)deg+=360;hsv.h=deg;emit();}
      else if(mode==='sv'){hsv.s=clamp((p.x-left)/sq);hsv.v=1-clamp((p.y-top)/sq);emit();}
    }
    canvas.addEventListener('pointerdown',e=>{const p=coords(e);drag=chooseMode(p);if(!drag)return;canvas.setPointerCapture(e.pointerId);update(p,drag);e.preventDefault();});
    canvas.addEventListener('pointermove',e=>{if(!drag)return;update(coords(e),drag);e.preventDefault();});
    canvas.addEventListener('pointerup',()=>drag=null);canvas.addEventListener('pointercancel',()=>drag=null);
    function setHex(hex,silent=false){const rgb=hexToRgb(hex);if(!rgb)return false;hsv=rgbToHsv(rgb.r,rgb.g,rgb.b);draw();if(!silent)onChange(value(),{...hsv});return true;}
    draw();
    return {getHex:value,setHex,redraw:draw};
  }
  window.ToneColorPicker={create,hexToRgb,rgbToHex};
})();
