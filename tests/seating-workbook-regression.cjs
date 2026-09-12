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
  for(const centerOffset of [-6,0,5]){
    const shifted={...plan,centerOffset,orchestraCenterOffset:1,rows:plan.rows.map(row=>({...row,seats:row.seats.concat(Array(7).fill(null))}))};
    const workbook=await disk(core.build(ExcelJS,shifted,members,{reserveSeats:0}));
    assert.equal(core.parse(workbook,members).snapshot.centerOffset,centerOffset,'half-seat center survives XLSX roundtrip');
    assert.equal(core.parse(workbook,members).snapshot.orchestraCenterOffset,1,'orchestra center is independent');
    assert.equal(workbook.getWorksheet('합창 배치').getRow(3).values.filter(value=>value==='센터').length,2);
  }
  assert.equal(result.snapshot.planId,'');assert.equal(result.snapshot.history.length,0);
  assert.equal(w.getWorksheet('_앱정보').state,'veryHidden');
  const list=w.getWorksheet('_단원목록');
  assert.equal(list.state,'veryHidden');assert.equal(list.rowCount,members.length);
  assert.deepEqual(w.definedNames.getRanges('ChoirMemberNames').ranges,["'_단원목록'!$A$1:$A$7"]);
  const dropdown=w.getWorksheet('합창 배치').getCell('D6').dataValidation;
  assert.equal(dropdown.type,'list');assert.deepEqual(dropdown.formulae,['ChoirMemberNames']);
  assert.equal(dropdown.allowBlank,true);assert.notEqual(dropdown.showErrorMessage,true);
  assert.equal(w.getWorksheet('역할').getCell('C2').dataValidation.type,'list');
  assert.equal(w.getWorksheet('관현악 배치').getCell('C4').dataValidation.type,'list');
  assert.deepEqual(list.getColumn(1).values.filter(Boolean),['김하민 [S1]','반주자','윤하은','김하민 [T1]','스태프','추가단원','이사람']);
  const colorRule=w.getWorksheet('합창 배치').conditionalFormattings.find(rule=>rule.ref==='C4:D4');
  assert.equal(colorRule.rules.length,5);
  assert.equal(colorRule.rules[2].formulae[0],'COUNTIF(ChoirPart2,$C4)>0');
  assert.equal(colorRule.rules[2].style.fill.fgColor.argb,'FFE5EEDC');
  assert.equal(colorRule.rules[3].style.fill.fgColor.argb,'FFFFE7B5');
  assert.equal(w.getWorksheet('합창 배치').getCell('C4').fill.fgColor.argb,'FFF5F5F1','cleared seats should not keep the previous part color');
  assert.deepEqual(w.definedNames.getRanges('ChoirPart3').ranges,["'_단원목록'!$E$1:$E$2"]);
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
  const choices=w.getWorksheet('_단원목록').getColumn(1).values.filter(Boolean);
  assert.ok(choices.includes('김하민 [S1 · aa]'));
  w.getWorksheet('합창 배치').getCell('D6').value='김하민 [S1 · aa]';
  assert.equal(core.parse(await disk(w),samePart).snapshot.rows[1].seats[0].memberId,'aa','new duplicate-name dropdown choice must resolve');
  const privateData=members.map(m=>({...m,phone:'PRIVATE_PHONE',pin:'PRIVATE_PIN'}));
  w=core.build(ExcelJS,plan,privateData);
  assert.ok(!JSON.stringify(w.model).includes('PRIVATE_'),'export name and part only');
  assert.equal(w.getWorksheet('합창 배치').getCell('C4').dataValidation.type,'list');
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
  for(const label of ['김하민(S1)','김하민 [ s1 ]','김하민（Ｓ１）','김하민(S1)'.normalize('NFD')]){
    w=build();w.getWorksheet('합창 배치').getCell('C4').value=label;
    result=core.parse(await disk(w),members);
    assert.deepEqual(result.issues,[]);assert.equal(result.snapshot.rows[0].seats[0].memberId,'a');
  }
  w=core.build(ExcelJS,{...plan,attendees:{...plan.attendees,deletedMember:true}},members,{reserveSeats:0});
  result=core.parse(await disk(w),members);
  assert.deepEqual(result.issues,[]);assert.equal(result.warnings.length,1);assert.equal(result.snapshot.attendees.deletedMember,undefined);
  assert.equal(result.attended,7);assert.equal(result.placed,5);
  result=core.parse(w,members.filter(m=>m.id!=='a'));
  assert.ok(result.issues.some(message=>message.includes('김하민')),'missing seated member must still block import');
  w.getWorksheet('합창 배치').getCell('C4').value='김하민';
  assert.ok(core.parse(w,members).issues.some(message=>message.includes('동명이인')),'never guess ambiguous names');
  w=core.build(ExcelJS,{...plan,folder:'찬양의밤',micVisible:false},members,{reserveSeats:0});
  result=core.parse(await disk(w),members);assert.equal(result.snapshot.folder,'찬양의밤');assert.equal(result.snapshot.micVisible,false);
  result=core.parse(await disk(build()),members);assert.equal(result.snapshot.folder,'');assert.equal(result.snapshot.micVisible,true);
  console.log('PASS: XLSX roundtrip, empty front row, identities, edited names, duplicate people, ambiguous names, bounds, formulas, roles, attendance, flags, new-plan isolation.');
})().catch(e=>{console.error(e);process.exitCode=1;});
