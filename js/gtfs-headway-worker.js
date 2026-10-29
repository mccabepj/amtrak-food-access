/* Extension of the existing dwell/date worker. Do not rename the base worker. */
importScripts('./gtfs-worker.js');
const baseHandler=self.onmessage;
const SEARCH_DAYS=7;
const SEARCH_MS=SEARCH_DAYS*86400000;
function nextStrictlyLater(candidates,epoch){
    let low=0,high=candidates.length;
    while(low<high){const mid=(low+high)>>>1;if(candidates[mid].epoch<=epoch)low=mid+1;else high=mid;}
    const candidate=candidates[low];
    return candidate&&candidate.epoch<=epoch+SEARCH_MS?candidate:null;
}
function segmentWithHeadways(p){
    const result=segment(p);
    result.searchDays=SEARCH_DAYS;
    const departures=result.rows.map(r=>r.departure?.epoch).filter(Number.isFinite);
    if(!departures.length){
        result.rows=result.rows.map(r=>({...r,nextTrain:null,nextStatus:'Departure time unavailable'}));
        return result;
    }
    let first=Infinity,last=-Infinity;
    for(const epoch of departures){first=Math.min(first,epoch);last=Math.max(last,epoch);}
    const origins=descendants(p.from),destinations=descendants(p.to),pairs=[];
    for(const id of origins)for(const pair of model.segments.get(id)||[]){
        if(!destinations.has(pair.b.stop_id))continue;
        if((pair.a.pickup_type||'0')==='1'||(pair.b.drop_off_type||'0')==='1')continue;
        if(T.seconds(pair.a.departure_time)===null)continue;
        pairs.push(pair);
    }
    // Enumerate service dates, including earlier service days whose trips
    // reach this station after midnight. Calendar exceptions are applied by active().
    const start=T.shift(T.parts(first,model.timezone).date,-model.maxOffset-2);
    const end=T.shift(T.parts(last+SEARCH_MS,model.timezone).date,2);
    const candidates=[];
    for(let date=start;date<=end;date=T.shift(date,1)){
        const key=date.replaceAll('-','');
        if(model.minDate&&(key<model.minDate||key>model.maxDate))continue;
        const services=active(date);
        if(!services.size)continue;
        for(const pair of pairs){
            const trip=model.trips.get(pair.a.trip_id);
            if(!trip||!services.has(trip.service_id))continue;
            const epoch=T.epoch(date,pair.a.departure_time,model.timezone);
            if(epoch<=first||epoch>last+SEARCH_MS)continue;
            candidates.push({epoch,serviceDate:date,trip,pair});
        }
    }
    candidates.sort((a,b)=>a.epoch-b.epoch||a.trip.trip_id.localeCompare(b.trip.trip_id));
    result.rows=result.rows.map(row=>{
        if(!row.departure)return {...row,nextTrain:null,nextStatus:'Departure time unavailable'};
        const candidate=nextStrictlyLater(candidates,row.departure.epoch);
        if(!candidate)return {...row,nextTrain:null,nextStatus:`No qualifying departure found within ${SEARCH_DAYS} days in the loaded feed`};
        const a=candidate.pair.a,b=candidate.pair.b;
        const nextTrain={
            ...label(candidate.trip),serviceDate:candidate.serviceDate,
            departure:T.display(candidate.serviceDate,a.departure_time,model.timezone,zoneFor(a.stop_id,p.timeMode)),
            gapMinutes:(candidate.epoch-row.departure.epoch)/60000,
            pickup:a.pickup_type||'0',dropoff:b.drop_off_type||'0',
            timepoint:a.timepoint,
            conditional:['2','3'].includes(a.pickup_type)||['2','3'].includes(b.drop_off_type)
        };
        return {...row,nextTrain,nextStatus:'Found'};
    });
    return result;
}
self.onmessage=async event=>{
    const {id,action,payload}=event.data;
    if(action!=='segment'){return baseHandler(event);}
    try{
        if(!model)throw new Error('Feed is not loaded.');
        self.postMessage({type:'result',id,result:segmentWithHeadways(payload)});
    }catch(error){self.postMessage({type:'error',id,text:error.message||'Headway calculation failed.'});}
};
