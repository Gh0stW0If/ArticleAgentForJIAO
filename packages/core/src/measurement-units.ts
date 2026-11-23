/** Measurement units are normalized by spelling only; magnitudes are never converted. */
export interface MeasurementUnitNormalization {
  raw: string;
  canonical?: string;
  status: 'reported' | 'dimensionless' | 'not_reported' | 'not_applicable' | 'not_extractable' | 'unrecognized';
}
const aliases: Record<string,string> = {
  point:'point',points:'point',score:'point',scores:'point','分':'point','分数':'point',
  mm:'mm',millimeter:'mm',millimeters:'mm',millimetre:'mm',millimetres:'mm','毫米':'mm',
  cm:'cm',centimeter:'cm',centimeters:'cm',centimetre:'cm',centimetres:'cm','厘米':'cm',
  ml:'mL',milliliter:'mL',milliliters:'mL',millilitre:'mL',millilitres:'mL','毫升':'mL',
  l:'L',liter:'L',liters:'L',litre:'L',litres:'L','升':'L',
  s:'s',sec:'s',secs:'s',second:'s',seconds:'s','秒':'s',
  min:'min',mins:'min',minute:'min',minutes:'min','分钟':'min',
  h:'h',hr:'h',hrs:'h',hour:'h',hours:'h','小时':'h',
  d:'day',day:'day',days:'day','天':'day','日':'day',
  wk:'week',wks:'week',week:'week',weeks:'week','周':'week',
  mo:'month',month:'month',months:'month','月':'month',
  yr:'year',year:'year',years:'year','年':'year',
  '%':'%',percent:'%',percentage:'%','百分比':'%',
  n:'count',count:'count',counts:'count',case:'count',cases:'count',person:'count',persons:'count',people:'count','人':'count','例':'count','次':'count',
  'times/day':'event/day','events/day':'event/day','episodes/day':'event/day','次/日':'event/day','次/天':'event/day',
  'times/week':'event/week','events/week':'event/week','次/周':'event/week',
  'vms/day':'VMS/day','vms/d':'VMS/day','vmsperday':'VMS/day',
  'ml/min':'mL/min','ml/minute':'mL/min','毫升/分钟':'mL/min',
  kg:'kg',kilogram:'kg',kilograms:'kg','千克':'kg',
  mg:'mg',milligram:'mg',milligrams:'mg','毫克':'mg',
  'μg':'µg',ug:'µg','微克':'µg',g:'g',gram:'g',grams:'g','克':'g',
  hz:'Hz','赫兹':'Hz',mmhg:'mmHg','毫米汞柱':'mmHg',
  'kg/m2':'kg/m²','kg/m²':'kg/m²',
};
export function normalizeMeasurementUnit(input: unknown): MeasurementUnitNormalization {
  const raw=String(input??'').trim();
  const key=raw.normalize('NFKC').replace(/<[^>]*>/g,'').toLowerCase().replace(/\s*\/\s*/g,'/').replace(/\s+per\s+/g,'/').trim();
  if(!key||key==='nr')return {raw,status:'not_reported'};
  if(key==='na'||key==='n/a')return {raw,status:'not_applicable'};
  if(key==='ne')return {raw,status:'not_extractable'};
  if(/^(1|dimensionless|unitless|无量纲|无单位)$/.test(key))return {raw,canonical:'1',status:'dimensionless'};
  // Case has physical meaning for these units.
  if(raw==='mM')return {raw,canonical:'mmol/L',status:'reported'};
  if(raw==='M')return {raw,canonical:'mol/L',status:'reported'};
  const canonical=aliases[key]??aliases[key.replace(/\s+/g,'')];
  return canonical?{raw,canonical,status:'reported'}:{raw,status:'unrecognized'};
}

/** The project records a scale score as evidence, with NA as its standardized unit. */
export function normalizeOutcomeUnit(input: unknown): MeasurementUnitNormalization {
  const unit = normalizeMeasurementUnit(input);
  if (unit.canonical === 'point' || unit.status === 'not_applicable') {
    return { ...unit, canonical: 'NA', status: 'not_applicable' };
  }
  return unit;
}
