import { setDefaultResultOrder } from 'node:dns'

// Some networks advertise IPv6 DNS records without a usable IPv6 TLS route.
// Prefer IPv4 for outbound API calls while retaining normal DNS fallback behaviour.
setDefaultResultOrder('ipv4first')
