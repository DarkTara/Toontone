function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) };
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
function deg2rad(d){return d*Math.PI/180;}
function rad2deg(r){return r*180/Math.PI;}
function deltaE2000(lab1,lab2){
  const L1=lab1.L,a1=lab1.a,b1=lab1.b,L2=lab2.L,a2=lab2.a,b2=lab2.b;
  const C1=Math.sqrt(a1*a1+b1*b1),C2=Math.sqrt(a2*a2+b2*b2),Cbar=(C1+C2)/2;
  const G=.5*(1-Math.sqrt(Math.pow(Cbar,7)/(Math.pow(Cbar,7)+Math.pow(25,7))));
  const ap1=(1+G)*a1,ap2=(1+G)*a2,Cp1=Math.sqrt(ap1*ap1+b1*b1),Cp2=Math.sqrt(ap2*ap2+b2*b2);
  let hp1=rad2deg(Math.atan2(b1,ap1));if(hp1<0)hp1+=360;let hp2=rad2deg(Math.atan2(b2,ap2));if(hp2<0)hp2+=360;
  const dLp=L2-L1,dCp=Cp2-Cp1;let dhp=0;
  if(Cp1*Cp2!==0){dhp=hp2-hp1;if(dhp>180)dhp-=360;else if(dhp<-180)dhp+=360;}
  const dHp=2*Math.sqrt(Cp1*Cp2)*Math.sin(deg2rad(dhp/2));
  const Lbar=(L1+L2)/2,Cpbar=(Cp1+Cp2)/2;let hpbar=hp1+hp2;
  if(Cp1*Cp2===0)hpbar=hp1+hp2;else if(Math.abs(hp1-hp2)<=180)hpbar=(hp1+hp2)/2;else if(hp1+hp2<360)hpbar=(hp1+hp2+360)/2;else hpbar=(hp1+hp2-360)/2;
  const T=1-.17*Math.cos(deg2rad(hpbar-30))+.24*Math.cos(deg2rad(2*hpbar))+.32*Math.cos(deg2rad(3*hpbar+6))-.20*Math.cos(deg2rad(4*hpbar-63));
  const dTheta=30*Math.exp(-Math.pow((hpbar-275)/25,2));
  const Rc=2*Math.sqrt(Math.pow(Cpbar,7)/(Math.pow(Cpbar,7)+Math.pow(25,7)));
  const Sl=1+(.015*Math.pow(Lbar-50,2))/Math.sqrt(20+Math.pow(Lbar-50,2)),Sc=1+.045*Cpbar,Sh=1+.015*Cpbar*T;
  const Rt=-Math.sin(deg2rad(2*dTheta))*Rc;
  const x=dLp/Sl,y=dCp/Sc,z=dHp/Sh;
  return Math.sqrt(x*x+y*y+z*z+Rt*y*z);
}
function colorScore(aHex,bHex,multiplier=2) {
  const a=hexToRgb(aHex),b=hexToRgb(bHex);if(!a||!b)return {proximity:0,deltaE00:100};
  const dE=deltaE2000(rgbToLab(a),rgbToLab(b));
  const k=Math.max(.5,Math.min(5,Number(multiplier)||2));
  return {proximity:Math.max(0,Math.min(100,100-k*dE)),deltaE00:dE};
}
module.exports={hexToRgb,rgbToLab,deltaE2000,colorScore};
