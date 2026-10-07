import * as echarts from 'echarts/core'
import { LineChart, ScatterChart } from 'echarts/charts'
import { TooltipComponent, GridComponent, AxisPointerComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'
import { axisNumber, number, latencyLabel, timeLabel, type buildTrend } from './model'

echarts.use([LineChart,ScatterChart,TooltipComponent,GridComponent,AxisPointerComponent,CanvasRenderer])
export const init = echarts.init
export function createOptions(data: ReturnType<typeof buildTrend>, compact: boolean): EChartsCoreOption {
  const first = data.samples[0]?.timestamp, last = data.samples[data.samples.length-1]?.timestamp
  const axis = {type:'time' as const,min:first,max:first === last && first != null ? first+1000 : last,
    axisLine:{show:false},axisTick:{show:false},splitLine:{show:false},axisPointer:{show:true,snap:true,lineStyle:{color:'#9eb67c',width:1}},
    axisLabel:{color:'#a8b7bb',fontSize:12,hideOverlap:true,formatter:(value:number)=>timeLabel(value)}}
  const hasOverflow = data.overflow.length > 0
  const hasNumericP95 = data.p95.some(point=>point[1] != null)
  const grid = compact
    ? [{left:48,right:16,top:80,height:88},{left:48,right:16,top:258,height:88}]
    : [{left:252,right:26,top:24,height:112},{left:252,right:26,top:186,height:100}]
  if (hasOverflow) grid.push({left:compact ? 48 : 252,right:compact ? 16 : 26,top:compact ? 416 : 324,height:20})
  return {
    animation:false,backgroundColor:'transparent',
    grid,axisPointer:{link:[{xAxisIndex:'all'}]},
    xAxis:[{...axis,gridIndex:0,axisLabel:{...axis.axisLabel,show:false}},{...axis,gridIndex:1},
      ...(hasOverflow ? [{...axis,gridIndex:2,axisLabel:{show:false}}] : [])],
    yAxis:[...[0,1].map(index=>({type:'value',gridIndex:index,min:0,splitNumber:2,
      axisLabel:{show:index===0 || hasNumericP95,color:'#8d9e9f',fontSize:12,formatter:axisNumber},
      axisLine:{show:false},axisTick:{show:false},splitLine:{show:index===0 || hasNumericP95,lineStyle:{color:'#2a3a3e',type:'dashed'}}})),
      ...(hasOverflow ? [{type:'value',gridIndex:2,min:0,max:1,show:false,axisPointer:{show:false}}] : [])],
    tooltip:{trigger:'axis',renderMode:'richText',backgroundColor:'#f3f1e7',borderColor:'#a7b999',textStyle:{color:'#19242c',fontSize:14},confine:true,
      formatter:(params:unknown)=>{
        const rows = (Array.isArray(params)?params:[params]) as {value?:[number,unknown]}[]
        const point = data.samples.find(p=>p.timestamp === rows[0]?.value?.[0])
        return point ? timeLabel(point.timestamp,true) + '\n' + (point.enabled === false ? '监控关闭' :
          'QPS  '+number(point.qps,2)+' req/s\nP95  '+latencyLabel(point)+' ms\n统计窗口  '+point.windowSeconds+' 秒') : '此处没有采样'
      }},
    series:[
      {name:'QPS',type:'line',xAxisIndex:0,yAxisIndex:0,data:data.qps,smooth:false,connectNulls:false,showSymbol:data.samples.length===1,symbolSize:6,
        lineStyle:{width:2.5,color:'#c4f374'},itemStyle:{color:'#c4f374'},areaStyle:{color:new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:'#c4f37426'},{offset:1,color:'#c4f37400'}])}},
      {name:'P95',type:'line',xAxisIndex:1,yAxisIndex:1,data:data.p95,smooth:false,connectNulls:false,showSymbol:true,symbolSize:(_value:unknown,params:{dataIndex:number})=>data.p95.length===1 || (data.p95[params.dataIndex-1]?.[1]==null && data.p95[params.dataIndex+1]?.[1]==null) ? 5 : 0,
        lineStyle:{width:2,color:'#c9dddf'},itemStyle:{color:'#c9dddf'},areaStyle:{color:'#c9dddf07'}},
      // Fixed event lane: 0.5 is a layout position, never a latency value.
      ...(hasOverflow ? [{name:'P95 超范围',type:'scatter',xAxisIndex:2,yAxisIndex:2,data:data.overflow.map(timestamp=>[timestamp,0.5]),
        symbol:'triangle',symbolSize:12,clip:false,itemStyle:{color:'#edbe71'}}] : [])
    ]
  }
}
