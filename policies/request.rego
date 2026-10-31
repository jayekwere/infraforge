package infraforge
import rego.v1

deny contains "IF001: public ingress forbidden" if {
 some rule in input.ingress
 rule.cidr == "0.0.0.0/0"
}
deny contains "IF002: IAM action is outside allowlist" if {
 some action in input.iam
 not action in {"s3:GetObject", "logs:PutLogEvents", "logs:CreateLogStream"}
}
deny contains "IF003: encryption required" if { not input.encrypted }
deny contains "IF004: VPC must use RFC1918 space" if {
 not net.cidr_contains("10.0.0.0/8", input.cidr)
 not net.cidr_contains("172.16.0.0/12", input.cidr)
 not net.cidr_contains("192.168.0.0/16", input.cidr)
}
deny contains "IF005: ingress must stay inside VPC" if {
 some rule in input.ingress
 not net.cidr_contains(input.cidr, rule.cidr)
}
deny contains "IF006: AWS compute identity only supports scoped log stream actions" if {
 input.module == "aws-network-v1"
 some action in input.iam
 not action in {"logs:PutLogEvents", "logs:CreateLogStream"}
}
