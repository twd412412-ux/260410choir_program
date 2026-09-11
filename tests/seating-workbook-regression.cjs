const assert=require('node:assert/strict');
const ExcelJS=require('../assets/vendor/exceljs-4.4.0.min.js');
const core=require('../assets/seating-workbook.js');
const members=[{id:'a',name:'김하민',part:'S1'},{id:'b',name:'김하민',part:'T1'},{id:'c',name:'윤하은',part:'S2'},{id:'d',name:'이사람',part:'관현악'},{id:'e',name:'반주자',part:'S1'},{id:'f',name:'스태프',part:'T2'},{id:'g',name:'추가단원',part:'T2'}];
const seat=(id,flags={})=>({...members.find(m=>m.id===id),memberId:id,highlight:false,locked:false,...flags});
const plan={name:'전체 합창',title:'행사',date:'2026-09-11',program:'합창',attendees:{a:true,b:true,c:true,d:true,e:true,f:true,g:true},attendeesLocked:true,centerOffset:-1,micSlots:[true,false,true],rows:[{label:'1단',offset:.5,seats:[seat('a',{highlight:true}),seat('b',{locked:true}),null]},{label:'0단',offset:0,seats:[null,null,null]}],orchestraRows:[{label:'1열',offset:0,seats:[seat('d'),null]}],specialSlots:{conductor:null,accompanist:seat('e'),staff:[seat('f')]} };
function build(){return core.build(ExcelJS,plan,members,{reserveSeats:0});}
async function disk(w){const b=await w.xlsx.writeBuffer();const loaded=new ExcelJS.Workbook();await loaded.xlsx.load(b);return loaded;}
(async()=>{
  let w=await disk(build()),result=core.parse(w,members);
  assert.deepEqual(result.issues,[]);assert.equal(result.placed,5);assert.equal(result.attended,7);
  assert.equal(result.snapshot.rows.length,2);assert.deepEqual(result.snapshot.rows[1].seats,[null,null,null]);
  assert.equal(result.snapshot.rows[0].seats[0].memberId,'a');assert.equal(result.snapshot.rows[0].seats[1].memberId,'b');
  assert.equal(result.snapshot.rows[0].seats[0].highlight,true);assert.equal(result.snapshot.rows[0].seats[1].locked,true);
  assert.equal(result.snapshot.centerOffset,-1);assert.deepEqual(result.snapshot.micSlots,plan.micSlots);
  assert.equal(result.snapshot.planId,'');assert.equal(result.snapshot.history.length,0);
  assert.equal(w.getWorksheet('_앱정보').state,'veryHidden');
  w.getWorksheet('합창 배치').getCell('C4').value='윤하은';
  result=core.parse(w,members);assert.equal(result.snapshot.rows[0].seats[0].memberId,'c','changed name must override old cell identity');
  assert.ok(result.snapshot.attendees.a,'removed occupant remains attending and unplaced');
  w.getWorksheet('합창 배치').getCell('C4').value='김하민';
  assert.match(core.parse(w,members).issues.join(' '),/동명이인/);
  w.getWorksheet('합창 배치').getCell('C4').value='없는사람';assert.match(core.parse(w,members).issues.join(' '),/찾을 수 없습니다/);
  w=build();const sh=w.getWorksheet('합창 배치');sh.getCell('D6').value=sh.getCell('C4').value;
  assert.match(core.parse(w,members).issues.join(' '),/에도 배치/);
  sh.getCell('D6').value='추가단원';assert.equal(core.parse(w,members).snapshot.rows[1].seats[0].memberId,'g');
  sh.getCell('C6').value='윤하은';assert.throws(()=>core.parse(w,members),/칸수 밖/);sh.getCell('C6').value=null;
  sh.getCell('B6').value=4;assert.equal(core.parse(w,members).snapshot.rows[1].seats.length,4);sh.getCell('B6').value=3;
  sh.getCell('D6').value={formula:'HYPERLINK("https://example.com", "a")'};assert.throws(()=>core.parse(w,members),/수식/);
  w=build();w.removeWorksheet('관현악 배치');assert.throws(()=>core.parse(w,members),/관현악 배치/);
  w=build();w.removeWorksheet('역할');assert.throws(()=>core.parse(w,members),/역할 시트/);
  w=build();w.getWorksheet('합창 배치').getCell('A6').value='1단';assert.throws(()=>core.parse(w,members),/중복/);
  w=build();w.getWorksheet('합창 배치').getCell('B4').value=0;assert.throws(()=>core.parse(w,members),/칸수/);
  w=new ExcelJS.Workbook();w.addWorksheet('임의 엑셀');assert.throws(()=>core.parse(w,members),/내려받은/);
  const samePart=members.concat({id:'aa',name:'김하민',part:'S1'});
  w=core.build(ExcelJS,plan,samePart,{reserveSeats:0});assert.equal(core.parse(w,samePart).snapshot.rows[0].seats[0].memberId,'a');
  const solo={...plan,orchestraRows:[],specialSlots:{conductor:null,accompanist:null,staff:[null]}};
  w=await disk(core.build(ExcelJS,solo,members,{reserveSeats:0}));assert.equal(w.getWorksheet('관현악 배치'),undefined);assert.deepEqual(core.parse(w,members).snapshot.orchestraRows,[]);
  assert.equal(core.parse(w,members).snapshot.rows[1].seats.length,3);
  assert.equal(w.getWorksheet('합창 배치').getCell('D6').master.address,'D6');
  assert.equal(w.getWorksheet('합창 배치').getCell('E6').master.address,'D6');
  for(const counts of [[35,36,37,36,36],[10,10,10],[9,10,8],[1],[120]]){
    const p={...solo,rows:counts.map((n,i)=>({label:(counts.length-i-1)+'단',offset:(counts.length-i-1)%2/2,seats:Array(n).fill(null)}))};
    const geometry=core.boardGeometry(p.rows);
    for(let i=1;i<geometry.length;i++)assert.equal(Math.abs(geometry[i].start-geometry[i-1].start)%2,1,'adjacent rows not staggered');
    assert.deepEqual(core.parse(await disk(core.build(ExcelJS,p,members,{reserveSeats:0})),members).snapshot.rows,p.rows);
  }
  w=build();w.getWorksheet('_앱정보').getCell('B1').value=2;
  assert.deepEqual(core.parse(await disk(w),members).issues,[],'legacy v2 unsupported');
  const padded=core.reserveRows(solo.rows);
  assert.equal(padded.reduce((n,r)=>n+r.seats.length,0),200);
  assert.equal(solo.rows[0].seats.length,3,'export must not mutate live seats');
  w=await disk(core.build(ExcelJS,solo,members));
  let grid=w.getWorksheet('합창 배치');
  assert.equal(core.parse(w,members).snapshot.rows.length,5);
  grid.getCell('B4').value=20;
  assert.equal(core.parse(w,members).snapshot.rows[0].seats.length,20,'editable seat count');
  // Delete an entire empty row, including its merged boxes, as Excel does.
  for(const range of [...grid.model.merges])if(/^\D+4:\D+4$/.test(range))grid.unMergeCells(range);
  grid.getRow(4).eachCell(c=>{c.value=null;});
  assert.equal(core.parse(await disk(w),members).snapshot.rows.length,4,'removed row accepted');
  w=build();grid=w.getWorksheet('합창 배치');
  const moved=grid.getCell('C4').value;
  grid.unMergeCells('C4:D4');grid.getCell('C4').value=null;
  grid.getCell('D6').value=moved;
  result=core.parse(await disk(w),members);
  assert.deepEqual(result.issues,[],'cut cell with removed merge accepted');
  assert.equal(result.snapshot.rows[0].seats[0],null);
  assert.equal(result.snapshot.rows[1].seats[0].memberId,'a');
  grid.getCell('B4').value=1;assert.throws(()=>core.parse(w,members),/칸수 밖/,'never lose occupied seats when shrinking');
  w=build();w.getWorksheet('_앱정보').getCell('B1').value=1;
  for(const [name,rows] of [['합창 배치',plan.rows],['관현악 배치',plan.orchestraRows]]){
    const old=w.getWorksheet(name),g=core.boardGeometry(rows);
    const values=rows.map((r,i)=>[r.label,r.seats.length,...r.seats.map((_,j)=>old.getCell(g[i].row,g[i].start+j*2).value)]);
    w.removeWorksheet(name);const plain=w.addWorksheet(name);plain.addRow(['기존 파일']);plain.addRow([]);plain.addRow(['단','칸수']);values.forEach(v=>plain.addRow(v));
  }
  assert.deepEqual(core.parse(await disk(w),members).issues,[],'legacy v1 unsupported');
  console.log('PASS: XLSX roundtrip, empty front row, identities, edited names, duplicate people, ambiguous names, bounds, formulas, roles, attendance, flags, new-plan isolation.');
})().catch(e=>{console.error(e);process.exitCode=1;});
