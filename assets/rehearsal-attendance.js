(function () {
  'use strict';
  var state=null, loadToken=0;
  function box(){return document.getElementById('rehearsalAttendanceBody');}
  function permitted(){return canViewAttendance()||canCheckAttendance();}
  function dirty(){return state&&Object.keys(state.changes).length>0;}
  function discard(){return !dirty()||confirm('저장하지 않은 출석 체크가 있습니다. 변경을 버릴까요?');}
  function eligible(member,date){return member&&(!/^\d{4}-\d{2}-\d{2}$/.test(member.startDate)||member.startDate<=date);}
  function inScope(member){return state.scope.indexOf('ALL')!==-1||state.scope.indexOf(member.part)!==-1||state.scope.indexOf(member.subPart)!==-1;}
  function visible(member){return member&&(state.part==='all'||member.part===state.part||member.subPart===state.part)&&(!state.query||publicSeatingMatches(member,state.query));}
  function status(id){return Object.prototype.hasOwnProperty.call(state.changes,id)?state.changes[id]:((state.sessions[state.date]||{}).records||{})[id]||'';}
  function editable(member){return !!(member&&state.canEdit&&canCheckAttendance()&&!state.busy&&state.date<=state.today&&eligible(member,state.date)&&inScope(member)&&visible(member));}
  function members(){return state.members.filter(function(m){return eligible(m,state.date)&&visible(m)&&inScope(m);});}
  function partNameOrder(a,b){
    var order=['S1','S2','T1','T2','반주','지휘','스태프'];
    var x=order.indexOf(a.part),y=order.indexOf(b.part);
    return (x<0?99:x)-(y<0?99:y)||String(a.part||'').localeCompare(String(b.part||''),'ko')||a.name.localeCompare(b.name,'ko');
  }
  function dateLabel(date){return date.slice(5).replace('-','/')+' ('+['일','월','화','수','목','금','토'][new Date(date+'T00:00:00Z').getUTCDay()]+')';}
  function errorText(e){return e&&e.message||'요청을 처리하지 못했습니다. 다시 시도해주세요.';}
  function selectedDate(data,previous){return data.config.dates.indexOf(previous)!==-1?previous:data.config.dates.filter(function(d){return d<=data.today;}).slice(-1)[0]||data.config.dates[0]||'';}

  window.openRehearsalAttendance=function(){
    if(!permitted())return showToast('출결 권한이 필요합니다');
    if(!discard())return;
    openModal('modalRehearsalAttendance');
    return load();
  };
  // keep=true reloads after a failed save without discarding the unsaved checks.
  function load(keep){
    var token=++loadToken,previous=state&&state.date,actor=(currentUser&&currentUser.id||'')+'|'+adminRole;
    var kept=keep&&state?{date:state.date,changes:Object.assign({},state.changes),part:state.part,view:state.view,query:state.query,zoom:state.zoom}:null;
    if(kept){state.busy=true;state.error='';state.saveFailed=false;render();}
    else box().innerHTML='<p role="status">리허설 출석 불러오는 중...</p>';
    return withLoadDeadline(attendanceAdminCall('rehearsalLoad',{}),20000).then(function(data){
      if(token!==loadToken||!permitted()||actor!==((currentUser&&currentUser.id||'')+'|'+adminRole))return;
      state=Object.assign({},data,{actor:actor,date:selectedDate(data,previous),part:data.scope.length===1&&['S1','S2','T1','T2','관현악'].indexOf(data.scope[0])!==-1?data.scope[0]:'all',board:'choir',view:'board',query:'',zoom:innerWidth<=600?1.1:1,busy:false,changes:{},error:'',configDates:data.config.dates.slice()});
      state.members=state.members.filter(function(member){return member.part!=='관현악';});
      if(state.part==='관현악')state.part='all';
      state.memberMap={};state.members.forEach(function(m){state.memberMap[m.id]=m;});
      applySummaryPrefs();
      if(kept){
        state.part=kept.part;state.view=kept.view;state.query=kept.query;state.zoom=kept.zoom;
        var dropped=0;
        Object.keys(kept.changes).forEach(function(id){
          var member=state.memberMap[id];
          if(state.date===kept.date&&member&&eligible(member,state.date)&&inScope(member))change(id,kept.changes[id]);
          else dropped++;
        });
        if(dropped)state.error=dropped+'명은 배치도나 담당 범위에서 빠져 체크를 반영하지 못했습니다.';
      }
      render();
    }).catch(function(e){
      if(token!==loadToken)return;
      if(kept&&state){state.busy=false;state.saveFailed=true;state.error=errorText(e)+' 입력한 체크는 유지됩니다.';render();return;}
      box().innerHTML='<p class="ra-error" role="alert">'+escHtml(errorText(e))+'</p><button class="btn" onclick="RehearsalAttendance.reload()">다시 시도</button>';
    });
  }
  function seatHtml(seat){
    if(!seat||seat.part==='관현악')return '<div class="public-seating-seat empty"><b>빈칸</b></div>';
    var member=state.memberMap[seat.memberId],value=status(seat.memberId),can=editable(member);
    var label=!member?'대상 제외':!eligible(member,state.date)?'등록 전':value||'미체크';
    var dim=(state.query&&!String(seat.name||'').includes(state.query)&&!String(seat.part||'').includes(state.query))||member&&!visible(member);
    return '<button type="button" class="public-seating-seat '+partClass(member?member.part:seat.part)+(value==='출석'?' ra-present':value==='결석'?' ra-absent':'')+(dim?' ra-dim':'')+'" '+(!can?'disabled ':'')+'data-member-id="'+escAttr(seat.memberId||'')+'" aria-label="'+escAttr((seat.name||'')+' '+label)+'" aria-pressed="'+(value==='출석')+'" onclick="RehearsalAttendance.toggle(this.dataset.memberId)"><b>'+escHtml(seat.name||'이름 없음')+'</b><small>'+label+'</small></button>';
  }
  function boardHtml(){
    var rows=state.plan.rows||[];
    var max=publicSeatingMaxSeatCount(rows),width=seatingLeadWidth()*2+seatingRowWidthForSeatCount(max);
    var height=rows.length*64+64,center=seatingCenterLeftForSeatCount(max)+seatingCenterOffsetPixels(seatingPlanCenterOffset(state.plan,state.board),true);
    var html='<div class="ra-scroll" aria-label="단원 기준 리허설 출석 배치도"><div class="ra-scale" style="width:'+width*state.zoom+'px;height:'+height*state.zoom+'px"><div class="public-seating-board ra-board member-view" style="width:'+width+'px;height:'+height+'px;transform:scale('+state.zoom+')"><div class="ra-front">지휘자 방향 · 단원 기준</div><div class="public-seating-center-line" style="left:'+center+'px;top:46px"></div>';
    rows.map(function(row,r){return {row:row,r:r};}).reverse().forEach(function(entry){
      var row=entry.row,stagger=seatingRowDisplayOffset(row,entry.r,rows)===.5;
      var left=Math.max(0,seatingRowLeftForSeatCount(row.seats.length,max)-(stagger?seatingSeatPitch()/2:0));
      html+='<div class="public-seating-row"><div class="public-seating-row-label">'+escHtml(row.label||'')+'</div><div class="public-seating-row-count"></div><div class="public-seating-line" style="margin-left:'+left+'px">'+row.seats.slice().reverse().map(seatHtml).join('')+'</div></div>';
    });
    return html+'</div></div></div>';
  }
  var SUMMARY_PREF_KEY='choir_ra_summary_v1',LOW_RATE=50;
  function summaryPrefs(){try{var value=JSON.parse(localStorage.getItem(SUMMARY_PREF_KEY)||'{}');return value&&typeof value==='object'?value:{};}catch(e){return {};}}
  function saveSummaryPrefs(){try{localStorage.setItem(SUMMARY_PREF_KEY,JSON.stringify({part:state.summaryPart,key:state.summaryKey,dir:state.summaryDir,low:state.summaryLow}));}catch(e){}}
  function applySummaryPrefs(){
    var prefs=summaryPrefs();
    state.summaryPart=typeof prefs.part==='string'?prefs.part:'all';
    state.summaryKey=['rate','name','present'].indexOf(prefs.key)!==-1?prefs.key:'rate';
    state.summaryDir=prefs.dir==='desc'?'desc':'asc';
    state.summaryLow=prefs.low===true;
    state.summaryDetail='';
  }
  // A member is a target on a date when eligible and, once the session exists, listed in its memberIds.
  function targetOn(m,date){var session=state.sessions[date];return eligible(m,date)&&(!session||!Array.isArray(session.memberIds)||session.memberIds.indexOf(m.id)!==-1);}
  function recordOn(m,date){return ((state.sessions[date]||{}).records||{})[m.id]||'';}
  function summaryParts(){
    var parts=[];
    state.members.forEach(function(m){if(inScope(m)&&parts.indexOf(m.part)===-1)parts.push(m.part);});
    return parts.sort(function(a,b){return partNameOrder({part:a,name:''},{part:b,name:''});});
  }
  // Unchecked days are shown separately and must not count as absences in the rate.
  function memberStats(m,dates){
    var total=0,present=0,checked=0;
    dates.forEach(function(date){if(!targetOn(m,date))return;total++;var value=recordOn(m,date);if(value)checked++;if(value==='출석')present++;});
    return {member:m,total:total,present:present,checked:checked,unchecked:total-checked,rate:checked?Math.round(present/checked*100):null};
  }
  function compareStats(a,b){
    var dir=state.summaryDir==='desc'?-1:1,diff=0;
    if(state.summaryKey==='rate'){
      // Members with no checked day have no rate yet and stay at the end in both directions.
      if((a.rate===null)!==(b.rate===null))return a.rate===null?1:-1;
      diff=(a.rate||0)-(b.rate||0);
    }else if(state.summaryKey==='present')diff=a.present-b.present;
    else diff=a.member.name.localeCompare(b.member.name,'ko');
    return diff*dir||a.member.name.localeCompare(b.member.name,'ko');
  }
  function partOverviewHtml(dates,parts){
    var rows=parts.map(function(part){
      var group=state.members.filter(function(m){return inScope(m)&&m.part===part;}),allPresent=0,allChecked=0;
      var cells=dates.map(function(date){
        var target=group.filter(function(m){return targetOn(m,date);}),present=0,checked=0;
        target.forEach(function(m){var value=recordOn(m,date);if(value)checked++;if(value==='출석')present++;});
        allPresent+=present;allChecked+=checked;
        if(!target.length)return '<td>-</td>';
        if(!checked)return '<td class="ra-unchecked-cell">미체크</td>';
        return '<td>'+present+'/'+target.length+(checked<target.length?' <small class="ra-unchecked-note">미체크 '+(target.length-checked)+'</small>':'')+'</td>';
      });
      return '<tr><th scope="row">'+escHtml(part)+'</th>'+cells.join('')+'<td><b>'+(allChecked?Math.round(allPresent/allChecked*100)+'%':'-')+'</b></td></tr>';
    });
    return '<div class="ra-table-scroll ra-part-overview"><table><thead><tr><th>파트</th>'+dates.map(function(date){return '<th>'+dateLabel(date)+'</th>';}).join('')+'<th>출석률</th></tr></thead><tbody>'+(rows.join('')||'<tr><td>담당 단원이 없습니다</td></tr>')+'</tbody></table></div>';
  }
  function memberTableHtml(dates,parts){
    var shownParts=state.summaryPart==='all'?parts:[state.summaryPart],columns=dates.length+4,body='';
    var head=function(key,label){
      var on=state.summaryKey===key,arrow=on?(state.summaryDir==='asc'?' ▲':' ▼'):'';
      return '<th aria-sort="'+(on?(state.summaryDir==='asc'?'ascending':'descending'):'none')+'"><button type="button" class="ra-sort" data-key="'+key+'" onclick="RehearsalAttendance.sortBy(this.dataset.key)">'+label+arrow+'</button></th>';
    };
    shownParts.forEach(function(part){
      var stats=state.members.filter(function(m){return inScope(m)&&m.part===part;}).map(function(m){return memberStats(m,dates);});
      if(state.summaryLow)stats=stats.filter(function(s){return s.rate!==null&&s.rate<LOW_RATE;});
      if(!stats.length)return;
      stats.sort(compareStats);
      if(shownParts.length>1)body+='<tr class="ra-part-row"><th colspan="'+columns+'">'+escHtml(part)+' · '+stats.length+'명</th></tr>';
      stats.forEach(function(s){
        var m=s.member,open=state.summaryDetail===m.id;
        body+='<tr class="ra-member-row'+(s.rate!==null&&s.rate<LOW_RATE?' ra-low':'')+'"><td><button type="button" class="ra-name" aria-expanded="'+open+'" data-detail-id="'+escAttr(m.id)+'" onclick="RehearsalAttendance.detail(this.dataset.detailId)">'+escHtml(m.name)+'</button></td>'
          +dates.map(function(date){
            if(!targetOn(m,date))return '<td class="ra-mark ra-mark-none" title="'+dateLabel(date)+' 대상 아님">–</td>';
            var value=recordOn(m,date);
            return '<td class="ra-mark '+(value==='출석'?'ra-mark-present':value==='결석'?'ra-mark-absent':'ra-mark-unchecked')+'" title="'+dateLabel(date)+' '+(value||'미체크')+'">'+(value==='출석'?'✓':value==='결석'?'✗':'·')+'</td>';
          }).join('')
          +'<td title="체크 '+s.checked+'일 중 출석">'+s.present+'/'+s.checked+'</td><td>'+s.unchecked+'</td><td><b>'+(s.rate===null?'-':s.rate+'%')+'</b></td></tr>';
        if(open)body+='<tr class="ra-detail-row"><td colspan="'+columns+'">'+(dates.map(function(date){
          var session=state.sessions[date]||{},value=targetOn(m,date)?(recordOn(m,date)||'미체크'):'대상 아님';
          return '<span>'+dateLabel(date)+' <b>'+value+'</b>'+(session.updatedAt?' <small>('+escHtml(seatingPublishedTime(session.updatedAt))+' '+escHtml(session.updatedBy||'')+' 저장)</small>':'')+'</span>';
        }).join('')||'지난 리허설이 없습니다')+'</td></tr>';
      });
    });
    return '<div class="ra-table-scroll ra-member-table"><table><thead><tr>'+head('name','단원')+dates.map(function(date){return '<th>'+dateLabel(date)+'</th>';}).join('')+head('present','참석')+'<th>미체크</th>'+head('rate','출석률')+'</tr></thead><tbody>'
      +(body||'<tr><td colspan="'+columns+'">'+(state.summaryLow?'출석률 '+LOW_RATE+'% 미만 단원이 없습니다':'해당 단원이 없습니다')+'</td></tr>')+'</tbody></table></div>';
  }
  function summaryHtml(){
    var dates=state.config.dates.filter(function(date){return date<=state.today;}),parts=summaryParts();
    if(state.summaryPart!=='all'&&parts.indexOf(state.summaryPart)===-1)state.summaryPart='all';
    var tabs='<div class="ra-summary-tabs" role="tablist" aria-label="파트 선택">'+['all'].concat(parts).map(function(part){
      return '<button type="button" role="tab" aria-selected="'+(state.summaryPart===part)+'" data-part="'+escAttr(part)+'" onclick="RehearsalAttendance.summaryPart(this.dataset.part)">'+(part==='all'?'전체':escHtml(part))+'</button>';
    }).join('')+'</div>';
    var low='<label class="ra-low-filter"><input type="checkbox" '+(state.summaryLow?'checked ':'')+'onchange="RehearsalAttendance.lowOnly(this.checked)"> 출석률 '+LOW_RATE+'% 미만만</label>';
    return '<details class="ra-summary"><summary>리허설 출석 현황</summary><p class="ra-status">집계 날짜 · '+(dates.map(dateLabel).join(' · ')||'아직 없음')+' · 출석률은 체크한 날 기준</p>'
      +'<h4 class="ra-summary-title">파트별 회차</h4>'+partOverviewHtml(dates,parts)
      +'<h4 class="ra-summary-title">단원별 참석표</h4><div class="ra-summary-controls">'+tabs+low+'</div>'+memberTableHtml(dates,parts)
      +'<p class="ra-status">✓ 출석 · ✗ 결석 · · 미체크 · – 대상 아님 · 이름을 누르면 회차별 기록</p></details>';
  }
  function configHtml(){
    if(!state.canManage)return '';
    return '<details class="ra-config" '+(!state.plan?'open':'')+'><summary>관리자 날짜·배치도 설정</summary><label for="raPlan">전체 기준 배치도</label><select id="raPlan" onchange="RehearsalAttendance.configPlan(this.value)">'+(!state.config.planId?'<option value="">공개된 전체 배치도 선택</option>':'')+state.plans.map(function(plan){return '<option value="'+escAttr(plan.id)+'" '+(plan.id===(state.configPlan||state.config.planId)?'selected':'')+'>'+escHtml(plan.name)+'</option>';}).join('')+'</select><div class="ra-dates">'+state.configDates.map(function(date){return '<span class="ra-date">'+dateLabel(date)+'<button type="button" data-date="'+date+'" onclick="RehearsalAttendance.removeDate(this.dataset.date)" aria-label="'+date+' 제외">×</button></span>';}).join('')+'</div><div class="ra-config-row"><input type="date" id="raAddDate" aria-label="리허설 날짜 추가"><button class="btn" onclick="RehearsalAttendance.addDate()">날짜 추가</button><button class="btn btn-primary" id="raConfigSave" '+(state.busy?'disabled':'')+' onclick="RehearsalAttendance.configure()">설정 저장</button></div><p class="ra-status">날짜를 제외해도 기존 출석 기록은 삭제되지 않습니다.</p></details>';
  }
  function listHtml(){
    var list=members().sort(partNameOrder);
    return '<div class="ra-member-list">'+list.map(function(member){var value=status(member.id);return '<label class="ra-member '+(value==='출석'?'ra-present':value==='결석'?'ra-absent':'')+'"><input type="checkbox" '+(value==='출석'?'checked ':'')+(!editable(member)?'disabled ':'')+'data-member-id="'+escAttr(member.id)+'" onchange="RehearsalAttendance.toggle(this.dataset.memberId)"><span><b>'+escHtml(member.name)+'</b><small>'+escHtml(member.part)+' · '+(value||'미체크')+'</small></span></label>';}).join('')+(list.length?'':'<p class="ra-status">해당 단원이 없습니다.</p>')+'</div>';
  }
  function render(){
    if(!state||!permitted())return;
    var list=members(),present=list.filter(function(m){return status(m.id)==='출석';}).length,absent=list.filter(function(m){return status(m.id)==='결석';}).length;
    var session=state.sessions[state.date]||{},parts=['all','S1','S2','T1','T2'];
    var html='<div class="ra-controls"><div class="ra-toolbar"><label>날짜<select id="raDate" '+(state.busy?'disabled':'')+' onchange="RehearsalAttendance.changeDate(this.value)">'+state.config.dates.map(function(date){return '<option value="'+date+'" '+(date===state.date?'selected':'')+'>'+dateLabel(date)+'</option>';}).join('')+'</select></label><label>파트<select id="raPart" onchange="RehearsalAttendance.part(this.value)">'+parts.filter(function(part){return part==='all'||state.members.some(function(m){return inScope(m)&&(m.part===part||m.subPart===part);});}).map(function(part){var count=state.members.filter(function(m){return eligible(m,state.date)&&inScope(m)&&(part==='all'||m.part===part||m.subPart===part);}).length;return '<option value="'+part+'" '+(state.part===part?'selected':'')+'>'+(part==='all'?'담당 전체':part)+' '+count+'</option>';}).join('')+'</select></label><button class="btn ra-refresh" title="최신 출석 불러오기" '+(state.busy?'disabled':'')+' onclick="RehearsalAttendance.reload()">새로고침</button></div>';
    html+='<div class="ra-toolbar ra-view-row"><input type="search" aria-label="단원 검색" placeholder="단원 검색" value="'+escAttr(state.query)+'" oninput="RehearsalAttendance.search(this.value)"><div class="ra-view-toggle"><button type="button" aria-pressed="'+(state.view==='board')+'" onclick="RehearsalAttendance.view(\'board\')">자리표</button><button type="button" aria-pressed="'+(state.view==='list')+'" onclick="RehearsalAttendance.view(\'list\')">명단</button></div></div>';
    html+='<div class="ra-counts" role="status"><span>출석 <b>'+present+'</b></span><span>결석 <b>'+absent+'</b></span><span>미체크 <b>'+(list.length-present-absent)+'</b></span><span>'+list.length+'명</span></div>'+(state.date>state.today?'<p class="ra-status">예정 회차 · 날짜를 바꾸면 지난 리허설을 체크할 수 있습니다.</p>':'')+'</div><div class="ra-content">';
    if(state.error)html+='<p class="ra-error" role="alert">'+escHtml(state.error)+(state.saveFailed&&dirty()?' <button type="button" class="btn" '+(state.busy?'disabled ':'')+'onclick="RehearsalAttendance.refreshKeep()">최신 불러오기 (내 체크 유지)</button>':'')+'</p>';
    if(state.plan){
      html+='<div class="ra-board-heading"><strong>'+escHtml(state.plan.name||state.plan.title||'전체 배치도')+'</strong>'+(state.view==='board'?'<label class="ra-zoom">확대 <input type="range" min="50" max="150" step="10" value="'+Math.round(state.zoom*100)+'" aria-label="배치도 확대" oninput="RehearsalAttendance.zoom(this.value)"></label>':'')+'</div>';
      html+=state.view==='list'?listHtml():boardHtml();
      var seatIds=new Set([].concat(state.plan.rows||[],state.plan.orchestraRows||[]).flatMap(function(row){return row.seats||[];}).filter(Boolean).map(function(seat){return seat.memberId;}));
      var extra=state.members.filter(function(m){return !seatIds.has(m.id);});
      if(extra.length&&state.view==='board')html+='<div class="ra-filters">'+extra.map(function(m){return seatHtml({memberId:m.id,name:m.name,part:m.part});}).join('')+'</div>';
      if(session.afternoonImportedAt)html+='<p class="ra-status">9/20 오후 출결 반영 · '+Number(session.afternoonImportedCount||0)+'명</p>';
      html+=summaryHtml();
    }else html+='<p class="ra-status">관리자가 전체 기준 배치도를 지정하면 출석 체크를 시작할 수 있습니다.</p>';
    html+=configHtml()+'</div>';
    html+='<div class="ra-footer"><span id="raSaveStatus" role="status">'+(state.busy?'저장 중...':dirty()?'미저장 '+Object.keys(state.changes).length+'명':session.updatedAt?'저장 · '+escHtml(seatingPublishedTime(session.updatedAt))+' · '+escHtml(session.updatedBy||''):'체크 내역 없음')+'</span><div class="ra-save-actions"><button class="btn" '+(!state.canEdit||!canCheckAttendance()||state.busy||!state.plan||state.date>state.today?'disabled':'')+' onclick="RehearsalAttendance.markRemaining()">미체크 결석</button><button class="btn btn-primary" id="raSave" '+(!state.canEdit||!canCheckAttendance()||!dirty()||state.busy?'disabled':'')+' onclick="RehearsalAttendance.save()">출석 저장</button></div></div>';
    var content=box().querySelector('.ra-content'),contentTop=content?content.scrollTop:0,summary=box().querySelector('.ra-summary'),config=box().querySelector('.ra-config');
    var old=box().querySelector('.ra-scroll'),scroll=old?{x:old.scrollLeft,y:old.scrollTop}:null;
    box().innerHTML=html;
    content=box().querySelector('.ra-content');if(content)content.scrollTop=contentTop;
    if(summary&&summary.open&&box().querySelector('.ra-summary'))box().querySelector('.ra-summary').open=true;
    if(config&&config.open&&box().querySelector('.ra-config'))box().querySelector('.ra-config').open=true;
    var next=box().querySelector('.ra-scroll');if(next&&scroll){next.scrollLeft=scroll.x;next.scrollTop=scroll.y;}
  }
  function change(id,value){var baseline=((state.sessions[state.date]||{}).records||{})[id]||'';if(value===baseline)delete state.changes[id];else state.changes[id]=value;}
  window.RehearsalAttendance={
    close:function(){closeModal('modalRehearsalAttendance');},
    canClose:function(){if(state&&state.busy||!discard())return false;loadToken++;state=null;return true;},
    syncAccess:function(){if(state&&(!permitted()||state.actor!==((currentUser&&currentUser.id||'')+'|'+adminRole))){loadToken++;state=null;var modal=document.getElementById('modalRehearsalAttendance');modal.classList.remove('active');box().innerHTML='';syncLayoutState();}},
    reload:function(){if(state&&state.busy||!discard())return;return load();},
    changeDate:function(date){if(state.busy||!discard()){render();return;}if(state.config.dates.indexOf(date)===-1)return;state.date=date;state.changes={};state.error='';render();},
    toggle:function(id){var member=state.memberMap[id];if(!editable(member))return;change(id,status(id)==='출석'?'':'출석');render();},
    part:function(part){state.part=part;render();},board:function(board){state.board=board;render();},
    view:function(view){state.view=view==='list'?'list':'board';render();},
    configPlan:function(id){state.configPlan=id;},
    search:function(query){state.query=query;var input=box().querySelector('input[type=search]'),start=input&&input.selectionStart;render();input=box().querySelector('input[type=search]');input.focus();if(start!==null)try{input.setSelectionRange(start,start);}catch(e){}},
    zoom:function(value){state.zoom=Math.max(.5,Math.min(1.5,Number(value)/100));var board=box().querySelector('.ra-board'),scale=box().querySelector('.ra-scale');if(board){board.style.transform='scale('+state.zoom+')';scale.style.width=parseFloat(board.style.width)*state.zoom+'px';scale.style.height=parseFloat(board.style.height)*state.zoom+'px';}},
    // Applies to the selected part filter only; the name search must not silently narrow a bulk absence.
    markRemaining:function(){
      if(!state.canEdit||!canCheckAttendance()||state.busy||state.date>state.today)return;
      var list=state.members.filter(function(m){return eligible(m,state.date)&&inScope(m)&&(state.part==='all'||m.part===state.part||m.subPart===state.part)&&!status(m.id);});
      if(!list.length)return showToast('미체크 단원이 없습니다');
      if(!confirm((state.part==='all'?'담당 전체':state.part)+' 미체크 '+list.length+'명을 결석으로 표시할까요?'+(state.query?'\n검색어와 관계없이 적용됩니다.':'')))return;
      list.forEach(function(m){change(m.id,'결석');});render();
    },
    save:function(){
      if(!state||state.busy||!dirty()||!state.canEdit||!canCheckAttendance())return;
      var changes=Object.keys(state.changes).map(function(id){return {id:id,status:state.changes[id],baselineStatus:((state.sessions[state.date]||{}).records||{})[id]||''};});
      var target=state;
      state.busy=true;state.error='';render();
      return withLoadDeadline(attendanceAdminCall('rehearsalSave',{date:state.date,planId:state.config.planId,changes:changes}),20000).then(function(result){if(state!==target)return;state.sessions[state.date]=result.session;state.changes={};state.saveFailed=false;writeLog('리허설 출석 저장',state.date+' 변경 '+changes.length+'명');}).catch(function(e){if(state===target){state.error=errorText(e)+' 입력한 체크는 유지됩니다.';state.saveFailed=true;}}).finally(function(){if(state===target){state.busy=false;render();}});
    },
    refreshKeep:function(){if(!state||state.busy)return;return load(true);},
    summaryPart:function(part){if(!state)return;state.summaryPart=part||'all';state.summaryDetail='';saveSummaryPrefs();render();},
    // Same column toggles direction; a new column starts low-first (participation starts high-first).
    sortBy:function(key){
      if(!state||['rate','name','present'].indexOf(key)===-1)return;
      if(state.summaryKey===key)state.summaryDir=state.summaryDir==='asc'?'desc':'asc';
      else{state.summaryKey=key;state.summaryDir=key==='present'?'desc':'asc';}
      saveSummaryPrefs();render();
    },
    lowOnly:function(on){if(!state)return;state.summaryLow=!!on;state.summaryDetail='';saveSummaryPrefs();render();},
    detail:function(id){if(!state)return;state.summaryDetail=state.summaryDetail===id?'':id;render();},
    addDate:function(){var date=document.getElementById('raAddDate').value;if(!date)return;if(state.configDates.indexOf(date)===-1)state.configDates.push(date);state.configDates.sort();var plan=document.getElementById('raPlan').value;render();document.getElementById('raPlan').value=plan;box().querySelector('.ra-config').open=true;},
    removeDate:function(date){var plan=document.getElementById('raPlan').value;state.configDates=state.configDates.filter(function(d){return d!==date;});render();document.getElementById('raPlan').value=plan;box().querySelector('.ra-config').open=true;},
    configure:function(){
      if(!state.canManage||state.busy||!discard())return;
      var planId=document.getElementById('raPlan').value;
      if(!planId)return showToast('전체 기준 배치도를 선택해주세요');
      var target=state;
      state.busy=true;render();
      return withLoadDeadline(attendanceAdminCall('rehearsalConfigure',{dates:state.configDates,planId:planId,baselineVersion:state.config.version}),20000).then(function(){if(state!==target)return;state.changes={};return load();}).catch(function(e){if(state!==target)return;state.busy=false;showToast(errorText(e));render();});
    }
  };
  window.addEventListener('beforeunload',function(e){if(dirty()||state&&state.busy){e.preventDefault();e.returnValue='저장하지 않은 리허설 출석이 있습니다.';}});
}());
