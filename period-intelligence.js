'use strict';

const {normalizeIanaTimezone,localListeningParts}=require('./timezone-utils');
const DAY=86400000;
const VERSION=1;

function dateOnly(value) { return String(value||'').slice(0,10); }
function addDays(localDate,count) { const d=new Date(`${dateOnly(localDate)}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+count); return d.toISOString().slice(0,10); }
function monthStart(localDate) { return `${dateOnly(localDate).slice(0,7)}-01`; }
function nextMonth(localDate) { const d=new Date(`${monthStart(localDate)}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth()+1); return d.toISOString().slice(0,10); }
function weekStart(localDate) { const d=new Date(`${dateOnly(localDate)}T00:00:00Z`),dow=d.getUTCDay()||7; d.setUTCDate(d.getUTCDate()-(dow-1)); return d.toISOString().slice(0,10); }
function zonedDateToUtc(localDate,timezone) {
  const tz=normalizeIanaTimezone(timezone), target=Date.parse(`${dateOnly(localDate)}T00:00:00Z`); let guess=target;
  for(let i=0;i<4;i+=1) {
    const p=localListeningParts(guess,tz), represented=Date.parse(`${p.local_date}T${String(p.local_hour).padStart(2,'0')}:00:00Z`);
    const minuteParts=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess));
    const m=Object.fromEntries(minuteParts.filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
    const exact=Date.parse(`${m.year}-${m.month}-${m.day}T${m.hour}:${m.minute}:${m.second}Z`);
    const delta=target-exact; guess+=delta; if(Math.abs(delta)<1000)break;
  }
  return new Date(guess).toISOString();
}
function closedPeriodSpecs(startedAt,nowValue,timezone,trackingStartedAt=startedAt) {
  const tz=normalizeIanaTimezone(timezone), startLocal=localListeningParts(startedAt,tz).local_date, nowLocal=localListeningParts(nowValue,tz).local_date, specs=[];
  for(let cursor=weekStart(startLocal), guard=0;guard<520;cursor=addDays(cursor,7),guard+=1) {
    const end=addDays(cursor,7); if(end>nowLocal)break;
    specs.push({period_type:'week',local_start:cursor,local_end:end,utc_start:zonedDateToUtc(cursor,tz),utc_end:zonedDateToUtc(end,tz),initial_partial:cursor<startLocal,timezone:tz});
  }
  for(let cursor=monthStart(startLocal),guard=0;guard<120;cursor=nextMonth(cursor),guard+=1) {
    const end=nextMonth(cursor); if(end>nowLocal)break;
    specs.push({period_type:'month',local_start:cursor,local_end:end,utc_start:zonedDateToUtc(cursor,tz),utc_end:zonedDateToUtc(end,tz),initial_partial:cursor<startLocal,timezone:tz});
  }
  const trackingLocal=localListeningParts(trackingStartedAt,tz).local_date,first60End=addDays(trackingLocal,60);
  if(first60End<=nowLocal)specs.push({period_type:'tracking_60d',local_start:trackingLocal,local_end:first60End,utc_start:zonedDateToUtc(trackingLocal,tz),utc_end:zonedDateToUtc(first60End,tz),initial_partial:false,timezone:tz});
  return specs;
}
function ranked(rows,idKey,meta={}) {
  const totals=new Map(); for(const row of rows||[]) { const id=row[idKey]; if(id)totals.set(id,(totals.get(id)||0)+Number(row.scrobble_count||0)); }
  const sorted=[...totals].sort((a,b)=>b[1]-a[1]||String(a[0]).localeCompare(String(b[0]))); let rank=0,last=null;
  return sorted.map(([id,count],index)=>{ if(count!==last)rank=index+1; last=count; return {id,count,rank,...(meta[id]||{})}; });
}
function buildSnapshot(spec,{dailyTotals=[],dailyReleases=[],dailyArtists=[],artistSegments=[],releaseMeta={},artistMeta={},coverageRatio=0,coverageContinuous=false,epochId}) {
  const inRange=row=>String(row.local_date)>=spec.local_start&&String(row.local_date)<spec.local_end;
  const scrobbleTotal=dailyTotals.filter(inRange).reduce((n,row)=>n+Number(row.scrobble_count||0),0);
  const completeness=spec.initial_partial?'partial':coverageRatio>=.9?'complete':'incomplete';
  const segmentRows=(artistSegments||[]).filter(row=>row.metric_key===`${spec.period_type}:${spec.local_start}`);
  const segmentRankings={};
  for(const segment of ['day','night'])segmentRankings[segment]=ranked(segmentRows.filter(row=>row.segment===segment).map(row=>({...row,scrobble_count:row.scrobble_count??row.count})),'artist_id',artistMeta);
  const unresolvedSegments=Object.fromEntries(['day','night'].map(segment=>[segment,segmentRows.filter(row=>row.segment===segment&&!row.artist_id).reduce((n,row)=>n+Number(row.scrobble_count??row.count??0),0)]));
  return {epoch_id:epochId,period_type:spec.period_type,local_start:spec.local_start,local_end:spec.local_end,utc_start:spec.utc_start,utc_end:spec.utc_end,timezone:spec.timezone,coverage_ratio:Math.round(coverageRatio*10000)/10000,coverage_continuous:Boolean(coverageContinuous),completeness,scrobble_total:scrobbleTotal,rankings:{release_groups:ranked(dailyReleases.filter(inRange),'release_group_id',releaseMeta),artists:ranked(dailyArtists.filter(inRange),'artist_id',artistMeta),artist_segments:segmentRankings,artist_segment_unresolved:unresolvedSegments},snapshot_version:VERSION};
}

module.exports={DAY,VERSION,dateOnly,addDays,monthStart,nextMonth,weekStart,zonedDateToUtc,closedPeriodSpecs,ranked,buildSnapshot};
