/* Deterministic, local-only Camelot/BPM mix-order preview.
   This is a mix-planning heuristic, never a guarantee of a smooth transition.
   Indexed Camelot buckets keep 5,000+ track playlists responsive in WKWebView. */
(function(root){
 'use strict';
 function parse(track){
  const found=String(track?.camelot||track?.key||'').trim().toUpperCase().match(/^(1[0-2]|[1-9])([AB])$/);
  return found?{n:Number(found[1]),mode:found[2]}:null;
 }
 const bpmOf=track=>{const value=Number(track?.bpm);return Number.isFinite(value)&&value>0?value:Infinity;};
 const relation=(a,b)=>{
  const difference=Math.abs(a.n-b.n),distance=Math.min(difference,12-difference);
  return distance===0?(a.mode===b.mode?0:1):distance===1&&a.mode===b.mode?1:4+distance;
 };
 const tempoCost=(a,b)=>{
  if(!Number.isFinite(a)||!Number.isFinite(b))return 15;
  // DJ-friendly half-time/double-time relation is useful across hip-hop/house.
  return Math.min(30,Math.abs(a-b),Math.abs(a-2*b),Math.abs(2*a-b));
 };
 function nearestInBucket(bucket,currentBpm){
  if(!bucket.length)return null;
  if(!Number.isFinite(currentBpm)){
   // An unknown BPM cannot be ranked by tempo, so choose source order.
   let first=bucket[0];for(const row of bucket)if(row.i<first.i)first=row;
   return first;
  }
  let best=null,bestCost=Infinity;
  const consider=row=>{
   if(!row)return;
   const cost=tempoCost(currentBpm,row.bpm);
   if(cost<bestCost||(cost===bestCost&&(!best||row.i<best.i))){best=row;bestCost=cost;}
  };
  // Sorted tempos permit O(log bucket-size) candidate selection, instead of
  // scanning every song on each step. Check normal, half and double BPM.
  for(const goal of [currentBpm,currentBpm/2,currentBpm*2]){
   let lo=0,hi=bucket.length;
   while(lo<hi){const mid=(lo+hi)>>1;if(bucket[mid].bpm<goal)lo=mid+1;else hi=mid;}
   consider(bucket[lo]);consider(bucket[lo-1]);
  }
  // Retain unknown-BPM tracks as legitimate candidates (constant penalty 15).
  consider(bucket[bucket.length-1]?.bpm===Infinity?bucket[bucket.length-1]:null);
  return best;
 }
 function order(tracks){
  if(!Array.isArray(tracks))return [];
  const all=[],unknown=[],groups=new Map();
  tracks.forEach((track,i)=>{
   const key=parse(track),row={t:track,i,k:key,bpm:bpmOf(track)};
   if(!key){unknown.push(row);return;}
   all.push(row);
   const label=key.n+key.mode;
   if(!groups.has(label))groups.set(label,[]);
   groups.get(label).push(row);
  });
  if(!all.length)return tracks.slice();
  for(const bucket of groups.values())bucket.sort((a,b)=>a.bpm-b.bpm||a.i-b.i);
  const first=all[0],result=[first.t];
  const initial=groups.get(first.k.n+first.k.mode);
  initial.splice(initial.indexOf(first),1);
  let last=first,remaining=all.length-1;
  while(remaining>0){
   let best=null,bestBucket=null,bestScore=Infinity;
   for(const bucket of groups.values()){
    const candidate=nearestInBucket(bucket,last.bpm);
    if(!candidate)continue;
    const score=relation(last.k,candidate.k)*100+tempoCost(last.bpm,candidate.bpm);
    if(score<bestScore||(score===bestScore&&(!best||candidate.i<best.i))){
     best=candidate;bestBucket=bucket;bestScore=score;
    }
   }
   if(!best)break;
   bestBucket.splice(bestBucket.indexOf(best),1);
   result.push(best.t);last=best;remaining--;
  }
  return result.concat(unknown.map(row=>row.t));
 }
 root.MusicHubHarmonicOrder=order;
 if(typeof module!=='undefined')module.exports=order;
})(typeof window!=='undefined'?window:globalThis);
