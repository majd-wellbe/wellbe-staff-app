// Kenney city buildings -> one GLB pack for Corniche Run: flat vertex colours (no texture), walls split out (tinted per section in game),
// Beirut details baked in (roof water tanks, solar heaters, AC units, balconies). Kenney units kept; the game scales.
import {Document,NodeIO} from '@gltf-transform/core';import {KHRTextureTransform} from '@gltf-transform/extensions';import fs from 'fs';import {weld,quantize,meshopt,dedup,prune} from '@gltf-transform/functions';import {EXTMeshoptCompression,KHRMeshQuantization} from '@gltf-transform/extensions';import {MeshoptEncoder} from 'meshoptimizer';
const io=new NodeIO().registerExtensions([KHRTextureTransform]);
const KC='/tmp/claude-0/k/kenney_city-kit-commercial_2.1/Models/GLB format/';
const RGB=fs.readFileSync('/home/claude/pipe/kenney_city-kit-commercial_2.1.rgb');
const col=(u,v)=>{const x=Math.min(511,Math.max(0,Math.floor(u*512))),y=Math.min(511,Math.max(0,Math.floor(v*512))),i=(y*512+x)*3;return [RGB[i],RGB[i+1],RGB[i+2]]};
const lin=c=>Math.pow(c/255,2.2);
// colour rules: light neutral = wall (tint), blue glass = dark Beirut glass, slate = warm concrete, other colours kept a bit warmer
const classify=c=>{const [r,g,b]=c,mx=Math.max(r,g,b),mn=Math.min(r,g,b),L=(r+g+b)/3,sat=(mx-mn)/(mx||1);
  if(L>195&&sat<.12)return {wall:1,c:[1,1,1].map(v=>v*Math.min(1,L/236))};
  if(b>r+35&&b>g+10){const k=L/200;return {c:[lin(70)*k*1.6,lin(105)*k*1.6,lin(120)*k*1.6]}}           // glass: deep teal
  if(sat<.3){const k=L/255;return {c:[lin(Math.min(255,k*255*1.10)),lin(k*255*1.0),lin(k*255*.86)]}}  // slate greys -> warm concrete
  return {c:[lin(r),lin(g),lin(b)]}};
const SRC=process.argv[2]==='list'?null:null;
const FRONT=['a','b','c','d','e','f','g','h','i','j','k','l','m','n'].map(x=>'building-'+x).concat(['a','b','c','d','e'].map(x=>'building-skyscraper-'+x));
const BACK=['a','b','c','d','e','f','g','h','i','j','k','l','m','n'].map(x=>'low-detail-building-'+x).concat(['low-detail-building-wide-a','low-detail-building-wide-b']);
let seed=7;const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647};
// tiny geometry builders (triangles, flat normals, one colour each)
const boxT=(cx,cy,cz,sx,sy,sz,c,out)=>{const x0=cx-sx/2,x1=cx+sx/2,y0=cy-sy/2,y1=cy+sy/2,z0=cz-sz/2,z1=cz+sz/2;
  const q=(a,b,cc,d,n)=>{out.push([a,b,cc,n,c],[a,cc,d,n,c])};
  q([x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1],[0,0,1]);q([x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0],[0,0,-1]);
  q([x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y1,z1],[1,0,0]);q([x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0],[-1,0,0]);
  q([x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z0],[0,1,0]);q([x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1],[0,-1,0])};
const cylT=(cx,cy,cz,r,h,c,out,n=8)=>{for(let i=0;i<n;i++){const a0=i/n*Math.PI*2,a1=(i+1)/n*Math.PI*2,p=a=>[cx+Math.cos(a)*r,cz+Math.sin(a)*r],P0=p(a0),P1=p(a1),am=(a0+a1)/2,nn=[Math.cos(am),0,Math.sin(am)];
  const A=[P0[0],cy,P0[1]],B=[P1[0],cy,P1[1]],C=[P1[0],cy+h,P1[1]],D=[P0[0],cy+h,P0[1]];out.push([A,C,B,nn,c],[A,D,C,nn,c]);out.push([[cx,cy+h,cz],C,D,[0,1,0],c])}};
const L3=h=>[lin(parseInt(h.slice(1,3),16)),lin(parseInt(h.slice(3,5),16)),lin(parseInt(h.slice(5,7),16))];
const doc=new Document();const buf=doc.createBuffer();const scene=doc.createScene('env');
const matWall=doc.createMaterial('wall').setBaseColorFactor([1,1,1,1]).setRoughnessFactor(.9).setMetallicFactor(0);
const texB=doc.createTexture('colormap_beirut').setImage(fs.readFileSync('/home/claude/pipe/colormap_beirut.png')).setMimeType('image/png');
const matBack=doc.createMaterial('back').setBaseColorTexture(texB).setRoughnessFactor(.9).setMetallicFactor(0);
const matTrim=doc.createMaterial('trim').setBaseColorFactor([1,1,1,1]).setRoughnessFactor(.85).setMetallicFactor(0);
const prim=(tris,mat)=>{const n=tris.length*3,P=new Float32Array(n*3),N=new Float32Array(n*3),C=new Float32Array(n*3);let k=0;
  for(const t of tris){for(let v=0;v<3;v++){P.set(t[v],k*3);N.set(t[3],k*3);C.set(t[4],k*3);k++}}
  const p=doc.createPrimitive().setMaterial(mat).setAttribute('POSITION',doc.createAccessor().setType('VEC3').setArray(P).setBuffer(buf))
   .setAttribute('NORMAL',doc.createAccessor().setType('VEC3').setArray(N).setBuffer(buf)).setAttribute('COLOR_0',doc.createAccessor().setType('VEC3').setArray(C).setBuffer(buf));return p};
const stats=[];
for(const [list,back] of [[FRONT,0],[BACK,1]])for(const f of list){
  const src=await io.read(KC+f+'.glb');const wall=[],trim=[],tex=[];let mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9];
  for(const node of src.getRoot().listNodes()){const m=node.getMesh();if(!m)continue;const W=node.getWorldMatrix();
    const tf=p=>[W[0]*p[0]+W[4]*p[1]+W[8]*p[2]+W[12],W[1]*p[0]+W[5]*p[1]+W[9]*p[2]+W[13],W[2]*p[0]+W[6]*p[1]+W[10]*p[2]+W[14]];
    for(const p of m.listPrimitives()){const P=p.getAttribute('POSITION'),U=p.getAttribute('TEXCOORD_0'),I=p.getIndices(),n=I?I.getCount():P.getCount();
      for(let t=0;t<n;t+=3){const ix=[0,1,2].map(q=>I?I.getScalar(t+q):t+q),a=ix.map(i=>tf(P.getElement(i,[]))),uv=ix.map(i=>U.getElement(i,[]));
        const e1=a[1].map((v,q)=>v-a[0][q]),e2=a[2].map((v,q)=>v-a[0][q]);let nn=[e1[1]*e2[2]-e1[2]*e2[1],e1[2]*e2[0]-e1[0]*e2[2],e1[0]*e2[1]-e1[1]*e2[0]];const L=Math.hypot(...nn);if(L<1e-9)continue;nn=nn.map(v=>v/L);
        a.forEach(v=>{for(let q=0;q<3;q++){mn[q]=Math.min(mn[q],v[q]);mx[q]=Math.max(mx[q],v[q])}});
        const k=classify(col((uv[0][0]+uv[1][0]+uv[2][0])/3,(uv[0][1]+uv[1][1]+uv[2][1])/3));if(back)tex.push([a[0],a[1],a[2],nn,uv]);else (k.wall?wall:trim).push([a[0],a[1],a[2],nn,k.c])}}}
  // Beirut details (front row only; back row stays low detail)
  if(!back){const W=mx[0]-mn[0],D=mx[2]-mn[2],top=mx[1],cx=(mn[0]+mx[0])/2,cz=(mn[2]+mx[2])/2,H=top-mn[1];
    const nt=1+Math.floor(rnd()*3);for(let i=0;i<nt;i++){const tx=mn[0]+W*(.22+.56*rnd()),tz=mn[2]+D*(.22+.56*rnd()),blk=rnd()<.45;
      boxT(tx,top+.012,tz,.13,.024,.13,L3('#8f877b'),trim);cylT(tx,top+.024,tz,.045,.07,L3(blk?'#2b2b2e':'#f2f0ea'),trim)}
    if(rnd()<.6){const sx=mn[0]+W*(.25+.5*rnd()),sz=mn[2]+D*.3;boxT(sx,top+.04,sz,.16,.012,.1,L3('#33475a'),trim);boxT(sx,top+.07,sz+.05,.14,.035,.035,L3('#e9e6df'),trim)}
    if(rnd()<.5)cylT(mn[0]+W*.8,top,mn[2]+D*.75,.006,.09,L3('#d9d4c8'),trim,5);
    // balconies + AC units on the street face (+z in Kenney space) and the run-facing side (-x)
    const floors=Math.max(1,Math.round(H/.33));
    for(let f2=1;f2<floors;f2++){const y=mn[1]+f2*(H/floors);
      if(rnd()<.75){const bw=W*(.35+.3*rnd()),bx=mn[0]+W*(.1+(.8-bw/W)*rnd())+bw/2;boxT(bx,y,mx[2]+.035,bw,.018,.07,L3('#efe9dc'),trim);boxT(bx,y+.045,mx[2]+.068,bw,.07,.006,L3(rnd()<.5?'#f4f1ea':'#5a5f63'),trim)}
      if(rnd()<.55){const ax=mn[0]+W*(.12+.76*rnd());boxT(ax,y+.12,mx[2]+.02,.07,.05,.04,L3('#e6e3dc'),trim)}
      if(rnd()<.45){const az=mn[2]+D*(.15+.7*rnd());boxT(mn[0]-.02,y+.13,az,.04,.05,.07,L3('#e6e3dc'),trim)}}}
  const mesh=doc.createMesh(f);if(tex.length){const n=tex.length*3,P=new Float32Array(n*3),N=new Float32Array(n*3),UV=new Float32Array(n*2);let k=0;for(const t of tex)for(let v=0;v<3;v++){P.set(t[v],k*3);N.set(t[3],k*3);UV.set(t[4][v],k*2);k++}mesh.addPrimitive(doc.createPrimitive().setMaterial(matBack).setAttribute('POSITION',doc.createAccessor().setType('VEC3').setArray(P).setBuffer(buf)).setAttribute('NORMAL',doc.createAccessor().setType('VEC3').setArray(N).setBuffer(buf)).setAttribute('TEXCOORD_0',doc.createAccessor().setType('VEC2').setArray(UV).setBuffer(buf)))}if(wall.length)mesh.addPrimitive(prim(wall,matWall));if(trim.length)mesh.addPrimitive(prim(trim,matTrim));
  scene.addChild(doc.createNode(f).setMesh(mesh));stats.push(f+' w'+wall.length+' t'+trim.length+' h'+(mx[1]-mn[1]).toFixed(2))}

// sea-side rocks (Kenney Nature Kit), recoloured to Corniche limestone
const KN='/tmp/claude-0/k/kenney_nature-kit/Models/GLTF format/';
for(const f of ['rock_largeA','rock_largeB','rock_largeC','rock_largeD','rock_largeE','rock_largeF','stone_largeA','stone_largeC','stone_largeE']){
  const src=await io.read(KN+f+'.glb');const trim=[];
  for(const node of src.getRoot().listNodes()){const m=node.getMesh();if(!m)continue;const W=node.getWorldMatrix();
    const tf=p=>[W[0]*p[0]+W[4]*p[1]+W[8]*p[2]+W[12],W[1]*p[0]+W[5]*p[1]+W[9]*p[2]+W[13],W[2]*p[0]+W[6]*p[1]+W[10]*p[2]+W[14]];
    for(const p of m.listPrimitives()){const mn=(p.getMaterial()&&p.getMaterial().getName())||'',P=p.getAttribute('POSITION'),I=p.getIndices(),n=I?I.getCount():P.getCount();
      const c=mn==='grass'?L3('#a8946f'):mn==='dirt'?L3('#b9a684'):L3('#ad9f86');
      for(let t=0;t<n;t+=3){const ix=[0,1,2].map(q=>I?I.getScalar(t+q):t+q),a=ix.map(i=>tf(P.getElement(i,[])));
        const e1=a[1].map((v,q)=>v-a[0][q]),e2=a[2].map((v,q)=>v-a[0][q]);let nn=[e1[1]*e2[2]-e1[2]*e2[1],e1[2]*e2[0]-e1[0]*e2[2],e1[0]*e2[1]-e1[1]*e2[0]];const L=Math.hypot(...nn);if(L<1e-9)continue;
        const sh=.9+rnd()*.14;trim.push([a[0],a[1],a[2],nn.map(v=>v/L),c.map(v=>v*sh)])}}}
  const mesh=doc.createMesh(f);mesh.addPrimitive(prim(trim,matTrim));scene.addChild(doc.createNode(f).setMesh(mesh));stats.push(f+' t'+trim.length)}

// palms (Kenney Nature Kit), recoloured: date-palm trunk with ring bands, varied Mediterranean greens, stone tree pit at the base
for(const f of ['tree_palmDetailedTall','tree_palmDetailedShort','tree_palmTall','tree_palmBend','tree_palm']){
  const src=await io.read(KN+f+'.glb');const trim=[];let minY=1e9,R=0;
  const G=['#2f8f45','#3aa653','#287d3d','#46b05a','#33964a'].map(L3),T0=L3('#7d5c3d'),T1=L3('#96724c');
  for(const node of src.getRoot().listNodes()){const m=node.getMesh();if(!m)continue;const W=node.getWorldMatrix();
    const tf=p=>[W[0]*p[0]+W[4]*p[1]+W[8]*p[2]+W[12],W[1]*p[0]+W[5]*p[1]+W[9]*p[2]+W[13],W[2]*p[0]+W[6]*p[1]+W[10]*p[2]+W[14]];
    for(const p of m.listPrimitives()){const leaf=(p.getMaterial()&&p.getMaterial().getName())==='leafsGreen',P=p.getAttribute('POSITION'),I=p.getIndices(),n=I?I.getCount():P.getCount();
      for(let t=0;t<n;t+=3){const ix=[0,1,2].map(q=>I?I.getScalar(t+q):t+q),a=ix.map(i=>tf(P.getElement(i,[])));
        const e1=a[1].map((v,q)=>v-a[0][q]),e2=a[2].map((v,q)=>v-a[0][q]);let nn=[e1[1]*e2[2]-e1[2]*e2[1],e1[2]*e2[0]-e1[0]*e2[2],e1[0]*e2[1]-e1[1]*e2[0]];const L=Math.hypot(...nn);if(L<1e-9)continue;
        a.forEach(v=>{minY=Math.min(minY,v[1]);if(!leaf)R=Math.max(R,Math.hypot(v[0],v[2])*0)});
        const cy=(a[0][1]+a[1][1]+a[2][1])/3;let c;
        if(leaf){c=G[Math.floor(rnd()*G.length)];const tip=Math.min(1,Math.hypot((a[0][0]+a[1][0]+a[2][0])/3,(a[0][2]+a[1][2]+a[2][2])/3)/0.35);c=c.map((v,q)=>v*(1+.25*tip)+(q===0?.02*tip:0))}
        else c=(Math.floor(cy/0.045)%2?T0:T1);
        trim.push([a[0],a[1],a[2],nn.map(v=>v/L),c])}}}
  cylT(0,minY,0,.13,.02,L3('#d6cab0'),trim,10);cylT(0,minY+.02,0,.105,.003,L3('#5e4630'),trim,10);
  const mesh=doc.createMesh('palm-'+f);mesh.addPrimitive(prim(trim,matTrim));scene.addChild(doc.createNode('palm-'+f).setMesh(mesh));stats.push(f+' t'+trim.length)}
await MeshoptEncoder.ready;doc.createExtension(KHRMeshQuantization).setRequired(true);await doc.transform(dedup(),weld(),quantize({quantizePosition:14,quantizeNormal:8,quantizeColor:8,quantizeTexcoord:12}),meshopt({encoder:MeshoptEncoder,level:'high'}),prune());
const io2=new NodeIO().registerExtensions([EXTMeshoptCompression,KHRMeshQuantization]).registerDependencies({'meshopt.encoder':MeshoptEncoder});await io2.write('/home/claude/pipe/env_city.glb',doc);console.log(stats.join('\n'));console.log(fs.statSync('/home/claude/pipe/env_city.glb').size)
