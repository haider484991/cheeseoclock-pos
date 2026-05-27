/**
 * Tiny inline SVG chart primitives — no library. Good enough for POS dashboards.
 */
import { formatCents } from '@cheeseoclock/pos-domain';

interface BarChartProps {
  data: Array<{ label: string; value: number }>;
  height?: number;
  formatValue?: (v: number) => string;
  color?: string;
}

export function BarChart({
  data,
  height = 200,
  formatValue = (v) => formatCents(v),
  color = '#f59e0b',
}: BarChartProps) {
  if (data.length === 0) {
    return <div className="py-8 text-center text-stone-500">No data in this range.</div>;
  }
  const max = Math.max(...data.map((d) => d.value), 1);
  const barWidth = 100 / data.length;
  return (
    <div>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="h-48 w-full">
        {data.map((d, i) => {
          const h = (d.value / max) * (height - 30);
          const x = i * barWidth + barWidth * 0.1;
          const w = barWidth * 0.8;
          const y = height - 20 - h;
          return (
            <g key={i}>
              <rect x={x} y={y} width={w} height={h} fill={color} rx={0.5} />
              <title>
                {d.label}: {formatValue(d.value)}
              </title>
            </g>
          );
        })}
      </svg>
      <div className="grid text-center text-[10px] text-stone-500" style={{ gridTemplateColumns: `repeat(${data.length}, 1fr)` }}>
        {data.map((d, i) => (
          <div key={i} className="truncate" title={d.label}>
            {d.label}
          </div>
        ))}
      </div>
    </div>
  );
}

interface LineChartProps {
  points: Array<{ label: string; value: number }>;
  height?: number;
  formatValue?: (v: number) => string;
  color?: string;
}

export function LineChart({
  points,
  height = 200,
  formatValue = (v) => formatCents(v),
  color = '#f59e0b',
}: LineChartProps) {
  if (points.length === 0) {
    return <div className="py-8 text-center text-stone-500">No data in this range.</div>;
  }
  const max = Math.max(...points.map((p) => p.value), 1);
  const stepX = points.length > 1 ? 100 / (points.length - 1) : 50;
  const path = points
    .map((p, i) => {
      const x = i * stepX;
      const y = height - 20 - (p.value / max) * (height - 30);
      return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
    })
    .join(' ');
  return (
    <div>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="h-48 w-full">
        <path d={path} stroke={color} strokeWidth={1.5} fill="none" vectorEffect="non-scaling-stroke" />
        {points.map((p, i) => {
          const x = i * stepX;
          const y = height - 20 - (p.value / max) * (height - 30);
          return (
            <g key={i}>
              <circle cx={x} cy={y} r={1.2} fill={color}>
                <title>
                  {p.label}: {formatValue(p.value)}
                </title>
              </circle>
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between text-[10px] text-stone-500">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </div>
  );
}
