terraform {
  required_version = ">= 1.9, < 2.0"
}
variable "request" {
  type = object({ name = string, cidr = string, subnets = list(string) })
  validation {
    condition     = can(cidrnetmask(var.request.cidr))
    error_message = "An IPv4 network is required."
  }
}
resource "terraform_data" "network" {
  input = var.request
}
output "network" {
  value = terraform_data.network.output
}
