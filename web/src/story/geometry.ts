// Geometry of the 600 by 600 story picture.

export const CENTER = 300

export function polar(radius: number, degrees: number): [number, number] {
  const a = (degrees * Math.PI) / 180
  return [CENTER + radius * Math.cos(a), CENTER + radius * Math.sin(a)]
}

// An arc round the centre, clockwise from one angle to another.
export function arcPath(radius: number, from: number, to: number): string {
  const [x1, y1] = polar(radius, from)
  const [x2, y2] = polar(radius, to)
  const large = to - from > 180 ? 1 : 0
  return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${radius} ${radius} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`
}
