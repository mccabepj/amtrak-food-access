importScripts('./gtfs-time.js');
const T=GTFSTime;
let model=null;
const serviceCache=new Map();
function progress(text){self.postMessage({type:'progress',text});}
function index(rows,key){return new Map(rows.map(r=>[r[key],r]));}
function group(rows,key){const map=new Map();for(const r of rows){if(!map.has(r[key]))map.set(r[key],[]);map.get(r[key]).push(r);}return map;}
function coordinate(lon,lat){
    if(String(lon??'').trim()===''||String(lat??'').trim()==='')return null;
    const x=Number(lon),y=Number(lat);return Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x)<=180&&Math.abs(y)<=90?[x,y]:null;
}
function rail(r){const t=Number(r.route_type);return String(r.route_type??'').trim()!==''&&(t===2||(Number.isInteger(t)&&t>=100&&t<=117));}
function stopName(id){return model.stops.get(id)?.stop_name||id||'';}
function descendants(id){const ids=new Set([id]),queue=[id];while(queue.length)for(const r of model.children.get(queue.shift())||[])if(!ids.has(r.stop_id)){ids.add(r.stop_id);queue.push(r.stop_id);}return ids;}
function stopZone(id){
    const seen=new Set();let stop=model.stops.get(id);
    while(stop?.parent_station&&!seen.has(stop.parent_station)){seen.add(stop.parent_station);stop=model.stops.get(stop.parent_station);}
    return stop?.stop_timezone||model.timezone;
}
function zoneFor(id,mode){return mode==='local'?stopZone(id):model.timezone;}
function active(date){
    if(serviceCache.has(date))return serviceCache.get(date);
    const dt=T.validateDate(date),key=date.replaceAll('-',''),weekday=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][dt.getUTCDay()],ids=new Set();
    for(const r of model.calendar)if(r.start_date<=key&&r.end_date>=key&&r[weekday]==='1')ids.add(r.service_id);
    for(const r of model.exceptions.get(key)||[]){if(r.exception_type==='1')ids.add(r.service_id);else if(r.exception_type==='2')ids.delete(r.service_id);}
    serviceCache.set(date,ids);return ids;
}
function datesFor(date,mode){
    T.validateDate(date);if(mode==='service')return [date];
    const dates=[];
    for(let n=-model.maxOffset-2;n<=2;n++){
        const d=T.shift(date,n),key=d.replaceAll('-','');
        if(!model.minDate||(key>=model.minDate&&key<=model.maxDate))dates.push(d);
    }
    return dates;
}
function label(trip){
    const r=model.routes.get(trip.route_id)||{},rows=model.times.get(trip.trip_id)||[];
    return {trip_id:trip.trip_id,route_id:trip.route_id,service:trip.trip_short_name||r.route_short_name||r.route_long_name||trip.trip_id,
        destination:trip.trip_headsign||stopName(rows.at(-1)?.stop_id)};
}
function eventRow(row,date,timeMode){
    const trip=model.trips.get(row.trip_id),rows=model.times.get(row.trip_id)||[],z=zoneFor(row.stop_id,timeMode);
    const terminal=row===rows[0]||row===rows.at(-1);
    return {...label(trip),stop_id:row.stop_id,stop_name:stopName(row.stop_id),serviceDate:date,
        arrival:T.display(date,row.arrival_time,model.timezone,z),departure:T.display(date,row.departure_time,model.timezone,z),
        rawArrival:row.arrival_time||'',rawDeparture:row.departure_time||'',timepoint:row.timepoint,
        pickup:row.pickup_type||'0',dropoff:row.drop_off_type||'0',dwell:T.dwell(row.arrival_time,row.departure_time,terminal)};
}
function chronological(a,b){return (a.departure?.epoch??a.arrival?.epoch??Infinity)-(b.departure?.epoch??b.arrival?.epoch??Infinity);}
function stats(rows){
    const values=rows.map(r=>r.dwell.minutes).filter(v=>v!==null).sort((a,b)=>a-b),n=values.length;
    return {known:n,excluded:rows.length-n,median:n?(n%2?values[(n-1)/2]:(values[n/2-1]+values[n/2])/2):null,min:n?values[0]:null,max:n?values.at(-1):null};
}
function station(p){
    const rows=[],ids=descendants(p.stopId),displayZone=zoneFor(p.stopId,p.timeMode),omitted=new Set();
    for(const date of datesFor(p.date,p.dateMode)){
        const services=active(date);
        for(const id of ids)for(const r of model.byStop.get(id)||[]){
            if(!services.has(model.trips.get(r.trip_id).service_id))continue;
            const row=eventRow(r,date,p.timeMode);
            if(p.dateMode==='calendar'){
                if(!row.arrival&&!row.departure){omitted.add(`${date}|${r.trip_id}|${r.stop_sequence}`);continue;}
                // Parent-station descendants use the same inherited timezone.
                if(row.arrival?.date!==p.date&&row.departure?.date!==p.date)continue;
            }
            rows.push(row);
        }
    }
    const summary=stats(rows),threshold=Math.max(0,Number(p.minDwell)||0);
    const filtered=rows.filter(r=>threshold===0||(r.dwell.minutes!==null&&r.dwell.minutes>=threshold)).sort(chronological);
    return {name:stopName(p.stopId),rows:filtered.slice(0,200),total:filtered.length,unfiltered:rows.length,stats:summary,
        omittedUnknownTimes:omitted.size,timezone:displayZone,dateMode:p.dateMode};
}
function tripDetail(p){
    const trip=model.trips.get(p.tripId);if(!trip)throw new Error('Trip not found.');
    const rows=(model.times.get(p.tripId)||[]).map(r=>eventRow(r,p.serviceDate,p.timeMode)),points=model.shapes.get(trip.shape_id);
    return {...label(trip),serviceDate:p.serviceDate,active:active(p.serviceDate).has(trip.service_id),rows,
        shape:points?{type:'Feature',properties:{},geometry:{type:'LineString',coordinates:points}}:null};
}
function segment(p){
    const rows=[],origins=descendants(p.from),destinations=descendants(p.to);
    for(const date of datesFor(p.date,p.dateMode)){
        const services=active(date);
        for(const id of origins)for(const pair of model.segments.get(id)||[]){
            const trip=model.trips.get(pair.a.trip_id);
            if(!destinations.has(pair.b.stop_id)||!services.has(trip.service_id))continue;
            const departure=T.display(date,pair.a.departure_time,model.timezone,zoneFor(pair.a.stop_id,p.timeMode));
            const arrival=T.display(date,pair.b.arrival_time,model.timezone,zoneFor(pair.b.stop_id,p.timeMode));
            if(p.dateMode==='calendar'&&departure?.date!==p.date)continue;
            const dep=T.seconds(pair.a.departure_time),arr=T.seconds(pair.b.arrival_time);
            rows.push({...label(trip),serviceDate:date,departure,arrival,
                duration:dep!==null&&arr!==null&&arr>=dep?(arr-dep)/60:null,
                pickup:pair.a.pickup_type||'0',dropoff:pair.b.drop_off_type||'0',
                timepoint:pair.a.timepoint==='0'||pair.b.timepoint==='0'?'0':'1'});
        }
    }
    rows.sort(chronological);
    return {from:stopName(p.from),to:stopName(p.to),total:rows.length,rows:rows.slice(0,200)};
}
async function load(url,colors){
    importScripts('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js','https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js');
    progress('Downloading GTFS.zip…');const response=await fetch(url);
    if(!response.ok)throw new Error(`Could not load GTFS.zip (HTTP ${response.status}). Check data/GTFS.zip.`);
    const zip=await JSZip.loadAsync(await response.arrayBuffer()),entries=Object.values(zip.files).filter(e=>!e.dir&&!e.name.startsWith('__MACOSX/'));
    const names=entries.map(e=>e.name.split('/').pop().toLowerCase());
    async function read(name,required=false,fields=[]){
        const matches=entries.filter(e=>e.name.split('/').pop().toLowerCase()===name);
        if(matches.length>1)throw new Error(`Multiple copies of ${name}. Use one feed.`);
        if(!matches.length){if(required)throw new Error(`Missing ${name}.`);return [];}
        progress(`Reading ${name}…`);const text=await matches[0].async('string');
        if(!text.trim()){if(required)throw new Error(`${name} is empty.`);return [];}
        const result=Papa.parse(text,{header:true,delimiter:',',skipEmptyLines:'greedy',dynamicTyping:false,transformHeader:h=>h.replace(/^\uFEFF/,'').trim()});
        if(result.errors.length)throw new Error(`${name}: ${result.errors[0].message}`);
        for(const f of fields)if(!result.meta.fields.includes(f))throw new Error(`${name} is missing ${f}.`);
        return result.data;
    }
    const stops=await read('stops.txt',true,['stop_id','stop_name','stop_lat','stop_lon']);
    const allRoutes=await read('routes.txt',true,['route_id','route_type']);
    const allTrips=await read('trips.txt',true,['trip_id','route_id','service_id']);
    const allTimes=await read('stop_times.txt',true,['trip_id','stop_id','stop_sequence']);
    const shapeRows=await read('shapes.txt',false,['shape_id','shape_pt_lat','shape_pt_lon','shape_pt_sequence']);
    const calendar=await read('calendar.txt',false,['service_id','start_date','end_date','monday','tuesday','wednesday','thursday','friday','saturday','sunday']);
    const exceptions=await read('calendar_dates.txt',false,['service_id','date','exception_type']);
    const agencies=await read('agency.txt',true,['agency_name','agency_timezone']);
    const frequencies=await read('frequencies.txt');
    if(!calendar.length&&!exceptions.length)throw new Error('No service calendar found.');
    const timezones=[...new Set(agencies.map(a=>a.agency_timezone))];
    if(timezones.length!==1)throw new Error('This version requires one shared agency timezone.');
    const timezone=timezones[0];T.parts(Date.now(),timezone);
    const routes=allRoutes.filter(rail),routeIndex=index(routes,'route_id');
    if(!routes.length)throw new Error('No rail routes found.');
    const railTrips=allTrips.filter(t=>routeIndex.has(t.route_id)),railTripIndex=index(railTrips,'trip_id');
    const frequencyIds=new Set(frequencies.map(f=>f.trip_id)),trips=railTrips.filter(t=>!frequencyIds.has(t.trip_id)),tripIndex=index(trips,'trip_id');
    const railTimes=allTimes.filter(r=>railTripIndex.has(r.trip_id)),times=railTimes.filter(r=>tripIndex.has(r.trip_id));
    if(times.some(r=>!String(r.stop_sequence??'').trim()||!Number.isFinite(Number(r.stop_sequence))))throw new Error('Rail stop_times contains an invalid stop_sequence.');
    const byTrip=group(times,'trip_id'),segments=new Map();
    for(const rows of byTrip.values()){
        rows.sort((a,b)=>Number(a.stop_sequence)-Number(b.stop_sequence));
        for(let i=0;i<rows.length-1;i++){const a=rows[i],b=rows[i+1];if(!segments.has(a.stop_id))segments.set(a.stop_id,[]);segments.get(a.stop_id).push({a,b});}
    }
    const stopIndex=index(stops,'stop_id'),children=group(stops.filter(s=>s.parent_station),'parent_station'),usedStops=new Set(railTimes.map(r=>r.stop_id));
    for(const id of [...usedStops]){let stop=stopIndex.get(id);const seen=new Set([id]);while(stop?.parent_station&&!seen.has(stop.parent_station)){seen.add(stop.parent_station);usedStops.add(stop.parent_station);stop=stopIndex.get(stop.parent_station);}}
    const stationFeatures=stops.filter(s=>usedStops.has(s.stop_id)&&['','0','1'].includes(s.location_type||'')).flatMap(s=>{
        const c=coordinate(s.stop_lon,s.stop_lat);return c?[{type:'Feature',properties:{...s,name:s.stop_name},geometry:{type:'Point',coordinates:c}}]:[];
    });
    progress('Indexing shapes, dates, and dwell times…');
    const usedShapes=new Set(railTrips.map(t=>t.shape_id).filter(Boolean)),shapes=new Map();
    for(const [id,rows] of group(shapeRows.filter(r=>usedShapes.has(r.shape_id)),'shape_id')){
        if(rows.some(r=>!coordinate(r.shape_pt_lon,r.shape_pt_lat)||!String(r.shape_pt_sequence??'').trim()||!Number.isFinite(Number(r.shape_pt_sequence))))continue;
        rows.sort((a,b)=>Number(a.shape_pt_sequence)-Number(b.shape_pt_sequence));
        const points=rows.map(r=>coordinate(r.shape_pt_lon,r.shape_pt_lat)).filter((p,i,ps)=>!i||p[0]!==ps[i-1][0]||p[1]!==ps[i-1][1]);
        if(points.length>1)shapes.set(id,points);
    }
    const paths=[],seen=new Set();let missingShapes=0;
    for(const t of railTrips){const points=shapes.get(t.shape_id);if(!points){missingShapes++;continue;}const key=JSON.stringify([t.route_id,t.shape_id]);if(seen.has(key))continue;seen.add(key);const r=routeIndex.get(t.route_id);
        paths.push({type:'Feature',properties:{...r,shape_id:t.shape_id,name:r.route_long_name||r.route_short_name||r.route_id},geometry:{type:'LineString',coordinates:points}});
    }
    const bounds=[...calendar.flatMap(r=>[r.start_date,r.end_date]),...exceptions.map(r=>r.date)].filter(d=>/^\d{8}$/.test(d)).sort();
    let maxSeconds=0;for(const r of times)maxSeconds=Math.max(maxSeconds,T.seconds(r.arrival_time)||0,T.seconds(r.departure_time)||0);
    model={stops:stopIndex,routes:routeIndex,trips:tripIndex,times:byTrip,byStop:group(times,'stop_id'),children,segments,shapes,calendar,exceptions:group(exceptions,'date'),timezone,minDate:bounds[0],maxDate:bounds.at(-1),maxOffset:Math.ceil(maxSeconds/86400)};
    serviceCache.clear();
    let invalidZones=0,unprovidedZones=0;
    // Invalid stop timezone values explicitly fall back to agency time.
    for(const s of stops)if(s.stop_timezone){try{T.parts(Date.now(),s.stop_timezone);}catch{s.stop_timezone='';invalidZones++;}}
    for(const f of stationFeatures){let s=stopIndex.get(f.properties.stop_id),visited=new Set();while(s?.parent_station&&!visited.has(s.parent_station)){visited.add(s.parent_station);s=stopIndex.get(s.parent_station);}if(!s?.stop_timezone)unprovidedZones++;}
    const warnings=['Rail only; no schematic paths. Map shows all feed patterns, not just the selected date. Dwell does not identify smoke breaks or operational reasons.'];
    if(missingShapes)warnings.push(`${missingShapes} rail trips lack usable shapes; their schedules can still be queried.`);
    if(railTrips.length-trips.length)warnings.push(`${railTrips.length-trips.length} frequency-based trips are excluded from timetable queries.`);
    if(unprovidedZones)warnings.push(`${unprovidedZones} displayed locations lack an effective stop_timezone; local-mode display falls back to agency timezone there, not a geographically inferred timezone.`);
    if(invalidZones)warnings.push(`${invalidZones} invalid stop timezones were replaced with agency-timezone fallback.`);
    warnings.push('Blank times are not interpolated. Parent-station and platform points may overlap.');
    const layers=[];
    if(stationFeatures.length)layers.push({id:'stations',name:'Rail stations and stops',type:'point',color:colors.stations,visible:true,opacity:1,data:{type:'FeatureCollection',features:stationFeatures}});
    if(paths.length)layers.push({id:'routes',name:'Rail routes · supplied shapes',type:'line',color:colors.routes,visible:true,opacity:1,data:{type:'FeatureCollection',features:paths}});
    const today=T.parts(Date.now(),timezone).date,key=today.replaceAll('-','');
    const toDate=s=>`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
    const initialDate=bounds.length&&(key<bounds[0]||key>bounds.at(-1))?toDate(bounds[0]):today;
    return {layers,summary:{agencies:[...new Set(agencies.map(a=>a.agency_name))],timezone,stations:stationFeatures.length,paths:paths.length,calendarRange:bounds.length?`${toDate(bounds[0])} through ${toDate(bounds.at(-1))}`:'Not declared',warnings,files:names.filter(n=>n.endsWith('.txt')),initialDate}};
}
self.onmessage=async event=>{
    const {id,action,payload}=event.data;
    try{
        let result;
        if(action==='load')result=await load(payload.url,payload.colors);
        else{if(!model)throw new Error('Feed is not loaded.');if(action==='station')result=station(payload);else if(action==='trip')result=tripDetail(payload);else if(action==='segment')result=segment(payload);else throw new Error('Unknown query.');}
        self.postMessage({type:'result',id,result});
    }catch(error){self.postMessage({type:'error',id,text:error.message||'GTFS processing failed.'});}
};
