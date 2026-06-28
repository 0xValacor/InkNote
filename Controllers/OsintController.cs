using InkNote.Services;
using Microsoft.AspNetCore.Mvc;

namespace InkNote.Controllers;

[ApiController]
[Route("api/osint")]
public class OsintController(OsintService osint) : ControllerBase
{
    [HttpGet("dns")]
    public async Task<IActionResult> Dns([FromQuery] string target)
    {
        if (string.IsNullOrWhiteSpace(target)) return BadRequest("target required");
        return Ok(await osint.DnsAsync(target.Trim()));
    }

    [HttpGet("subdomains")]
    public async Task<IActionResult> Subdomains([FromQuery] string domain)
    {
        if (string.IsNullOrWhiteSpace(domain)) return BadRequest("domain required");
        return Ok(await osint.SubdomainsAsync(domain.Trim()));
    }

    [HttpGet("whois")]
    public async Task<IActionResult> Whois([FromQuery] string target)
    {
        if (string.IsNullOrWhiteSpace(target)) return BadRequest("target required");
        return Ok(await osint.WhoisAsync(target.Trim()));
    }

    [HttpGet("ip")]
    public async Task<IActionResult> IpInfo([FromQuery] string target)
    {
        if (string.IsNullOrWhiteSpace(target)) return BadRequest("target required");
        return Ok(await osint.IpInfoAsync(target.Trim()));
    }

    [HttpGet("shodan")]
    public async Task<IActionResult> Shodan([FromQuery] string target)
    {
        if (string.IsNullOrWhiteSpace(target)) return BadRequest("target required");
        return Ok(await osint.ShodanAsync(target.Trim()));
    }

    [HttpGet("hibp")]
    public async Task<IActionResult> Hibp([FromQuery] string email)
    {
        if (string.IsNullOrWhiteSpace(email)) return BadRequest("email required");
        return Ok(await osint.HibpAsync(email.Trim()));
    }

    [HttpGet("usernames")]
    public async Task<IActionResult> Usernames([FromQuery] string username)
    {
        if (string.IsNullOrWhiteSpace(username)) return BadRequest("username required");
        return Ok(await osint.UsernamesAsync(username.Trim()));
    }
}
