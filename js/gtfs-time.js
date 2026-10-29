/* Shared schedule-time utilities. Loaded by the worker, not the page. */
(() => {
    const formatters=new Map(), bases=new Map();
    function formatter(zone) {
        if(!formatters.has(zone)) formatters.set(zone,new Intl.DateTimeFormat('en-CA',{
            timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',
            hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'short'
        }));
        return formatters.get(zone);
    }
    function parts(epoch,zone) {
        const p=Object.fromEntries(formatter(zone).formatToParts(new Date(epoch)).map(x=>[x.type,x.value]));
        return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`,second:p.second,zone:p.timeZoneName};
    }
    function validateDate(date) {
        if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Choose a valid date.');
        const d=new Date(date+'T12:00:00Z');
        if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==date) throw new Error('Invalid date.');
        return d;
    }
    function shift(date,days) {const d=validateDate(date);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
    function seconds(value) {
        const m=/^(\d+):(\d{2}):(\d{2})$/.exec(value||'');
        return m&&Number(m[2])<60&&Number(m[3])<60 ? Number(m[1])*3600+Number(m[2])*60+Number(m[3]) : null;
    }
    // GTFS measures time from local service-day noon minus 12 elapsed hours.
    function base(date,zone) {
        const key=JSON.stringify([date,zone]);if(bases.has(key)) return bases.get(key);
        validateDate(date);
        const target=Date.parse(date+'T12:00:00Z');let epoch=target;
        for(let i=0;i<5;i++) {
            const p=parts(epoch,zone);
            const displayed=Date.parse(`${p.date}T${p.time}:${p.second}Z`);
            const correction=target-displayed;epoch+=correction;if(!correction)break;
        }
        const p=parts(epoch,zone);
        if(p.date!==date||p.time!=='12:00') throw new Error(`Could not resolve service-day noon in ${zone}.`);
        const value=epoch-12*3600000;bases.set(key,value);return value;
    }
    function epoch(date,value,zone) {const s=seconds(value);return s===null?null:base(date,zone)+s*1000;}
    function display(date,value,agencyZone,displayZone) {
        const e=epoch(date,value,agencyZone);return e===null?null:{...parts(e,displayZone),timezone:displayZone,epoch:e};
    }
    function dwell(arrival,departure,terminal=false) {
        if(terminal)return {minutes:null,status:'Trip endpoint'};
        const a=seconds(arrival),d=seconds(departure);
        if(a===null||d===null)return {minutes:null,status:'Unknown'};
        if(d<a)return {minutes:null,status:'Invalid: departure precedes arrival'};
        return {minutes:(d-a)/60,status:d===a?'Zero recorded dwell':'Scheduled dwell'};
    }
    globalThis.GTFSTime={parts,validateDate,shift,seconds,base,epoch,display,dwell};
})();
