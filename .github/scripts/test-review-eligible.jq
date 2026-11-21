{"draft":false,"state":"open","head":{"repo":{"full_name":"gordonpn/shunt-shim"}},"user":{"type":"User","login":"gordonpn"}} as $base |
.[] | . as $case |
($base * $case.patch) as $pr |
[$case.name, $pr, $case.expected] | @json
