if $event_name == "pull_request" then
  {"pull_request": .[1]}
else
  {"issue": {"number": 123, "pull_request": {"url": "https://api.github.com/repos/gordonpn/shunt-shim/pulls/123"}}}
end
