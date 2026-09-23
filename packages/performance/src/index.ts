export interface ProcessSample {
  readonly runId:string;
  readonly configuration:"baseline"|"candidate";
  readonly workloadSize:3|12;
  readonly timestamp:number;
  readonly pid:number;
  readonly startIdentity:string;
  readonly role:string;
  readonly privateBytes:number;
  readonly privateWorkingSet:number;
  readonly cpuPercent:number;
}

export interface RunSummary {
  readonly configuration:"baseline"|"candidate";
  readonly workloadSize:3|12;
  readonly medianPrivateBytes:number;
  readonly peakPrivateBytes:number;
  readonly p95PrivateBytes:number;
  readonly sampleCount:number;
}

function quantile(values:readonly number[], q:number):number {
  if(!values.length) throw new Error("측정값이 없습니다.");
  const sorted=[...values].sort((a,b)=>a-b);
  const index=Math.min(sorted.length-1,Math.max(0,Math.ceil(q*sorted.length)-1));
  return sorted[index]!;
}
export function summarize(samples:readonly ProcessSample[]):RunSummary[] {
  const groups=new Map<string,ProcessSample[]>();
  for(const sample of samples){
    const key=`${sample.configuration}:${sample.workloadSize}`;
    groups.set(key,[...(groups.get(key)??[]),sample]);
  }
  return [...groups.values()].map(group=>{
    const totalsByTimestamp=new Map<number,number>();
    for(const sample of group) totalsByTimestamp.set(sample.timestamp,(totalsByTimestamp.get(sample.timestamp)??0)+sample.privateBytes);
    const totals=[...totalsByTimestamp.values()];
    return {
      configuration:group[0]!.configuration,workloadSize:group[0]!.workloadSize,
      medianPrivateBytes:quantile(totals,0.5),peakPrivateBytes:Math.max(...totals),
      p95PrivateBytes:quantile(totals,0.95),sampleCount:group.length
    };
  });
}
export interface Comparison {
  readonly workloadSize:3|12;
  readonly medianReductionPercent:number;
  readonly peakReductionPercent:number;
}
export function compare(summaries:readonly RunSummary[]):Comparison[] {
  const result:Comparison[]=[];
  for(const size of [3,12] as const){
    const baseline=summaries.find(item=>item.configuration==="baseline"&&item.workloadSize===size);
    const candidate=summaries.find(item=>item.configuration==="candidate"&&item.workloadSize===size);
    if(!baseline||!candidate) throw new Error(`${size}개 작업 baseline/candidate 측정이 모두 필요합니다.`);
    if(baseline.medianPrivateBytes<=0||baseline.peakPrivateBytes<=0) throw new Error("baseline 메모리가 0이면 감소율을 계산할 수 없습니다.");
    result.push({
      workloadSize:size,
      medianReductionPercent:(baseline.medianPrivateBytes-candidate.medianPrivateBytes)/baseline.medianPrivateBytes*100,
      peakReductionPercent:(baseline.peakPrivateBytes-candidate.peakPrivateBytes)/baseline.peakPrivateBytes*100
    });
  }
  return result;
}
