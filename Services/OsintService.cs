using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace InkNote.Services;

public class OsintQueryResult
{
    public bool Success { get; set; }
    public string? Error { get; set; }
    public object? Data { get; set; }
    public List<EntitySuggestion> Suggestions { get; set; } = [];
}

public class EntitySuggestion
{
    public string Type { get; set; } = "";
    public string Label { get; set; } = "";
    public string RelationLabel { get; set; } = "";
    public string? Extra { get; set; }
}

public class OsintService(IHttpClientFactory httpFactory, IConfiguration config)
{
    private static readonly JsonSerializerOptions _json = new() { PropertyNameCaseInsensitive = true };

    private HttpClient MakeClient(int timeoutSec = 12)
    {
        var c = httpFactory.CreateClient();
        c.Timeout = TimeSpan.FromSeconds(timeoutSec);
        c.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent",
            "Mozilla/5.0 (compatible; InkNote-OSINT/1.0)");
        return c;
    }

    // ── DNS (Cloudflare DoH) ─────────────────────────────────────────────────

    public async Task<OsintQueryResult> DnsAsync(string target)
    {
        try
        {
            var types = new[] { ("A", 1), ("AAAA", 28), ("MX", 15), ("NS", 2), ("TXT", 16), ("CNAME", 5) };
            var records = new Dictionary<string, List<string>>();
            var suggestions = new List<EntitySuggestion>();

            using var client = MakeClient();
            client.DefaultRequestHeaders.Add("Accept", "application/dns-json");

            foreach (var (typeName, _) in types)
            {
                var url = $"https://cloudflare-dns.com/dns-query?name={Uri.EscapeDataString(target)}&type={typeName}";
                try
                {
                    var resp = await client.GetAsync(url);
                    if (!resp.IsSuccessStatusCode) continue;
                    var doh = await resp.Content.ReadFromJsonAsync<DohResponse>(_json);
                    var answers = doh?.Answer?.Select(a => a.Data).Where(d => !string.IsNullOrEmpty(d)).ToList() ?? [];
                    if (answers.Count > 0)
                        records[typeName] = answers!;

                    foreach (var data in answers)
                    {
                        if (data == null) continue;
                        switch (typeName)
                        {
                            case "A":
                            case "AAAA":
                                suggestions.Add(new EntitySuggestion { Type = "ip", Label = data, RelationLabel = $"{typeName} record" });
                                break;
                            case "MX":
                                var mxHost = data.Split(' ').LastOrDefault()?.TrimEnd('.') ?? data;
                                if (!string.IsNullOrEmpty(mxHost))
                                    suggestions.Add(new EntitySuggestion { Type = "domain", Label = mxHost, RelationLabel = "MX record", Extra = data });
                                break;
                            case "NS":
                                var ns = data.TrimEnd('.');
                                suggestions.Add(new EntitySuggestion { Type = "domain", Label = ns, RelationLabel = "nameserver" });
                                break;
                            case "CNAME":
                                suggestions.Add(new EntitySuggestion { Type = "domain", Label = data.TrimEnd('.'), RelationLabel = "CNAME" });
                                break;
                        }
                    }
                }
                catch { /* individual type failure is non-fatal */ }
            }

            return new OsintQueryResult { Success = true, Data = records, Suggestions = suggestions };
        }
        catch (Exception ex)
        {
            return new OsintQueryResult { Success = false, Error = ex.Message };
        }
    }

    // ── Subdomain enumeration (crt.sh + common wordlist) ────────────────────

    private static readonly string[] CommonSubdomains = [
        "www", "mail", "smtp", "pop", "imap", "ftp", "api", "dev", "staging", "test",
        "admin", "portal", "vpn", "remote", "webmail", "ns1", "ns2", "mx", "mx1", "mx2",
        "support", "help", "docs", "blog", "shop", "store", "cdn", "static", "assets",
        "app", "mobile", "m", "wap", "secure", "login", "auth", "sso", "id",
        "gitlab", "git", "svn", "jira", "confluence", "wiki",
        "jenkins", "build", "ci", "sonar", "monitor",
        "db", "database", "mysql", "postgres", "redis", "elastic", "kibana",
        "internal", "intranet", "corp", "office", "extranet",
        "beta", "alpha", "old", "legacy", "backup", "files", "upload"
    ];

    public async Task<OsintQueryResult> SubdomainsAsync(string domain)
    {
        try
        {
            var found = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            // crt.sh certificate transparency
            using var client = MakeClient(20);
            var url = $"https://crt.sh/?q=%.{Uri.EscapeDataString(domain)}&output=json";
            try
            {
                var resp = await client.GetAsync(url);
                if (resp.IsSuccessStatusCode)
                {
                    var entries = await resp.Content.ReadFromJsonAsync<List<CrtShEntry>>(_json);
                    if (entries != null)
                    {
                        foreach (var e in entries)
                        {
                            var names = (e.NameValue ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries);
                            foreach (var n in names)
                            {
                                var clean = n.Trim().TrimStart('*').TrimStart('.').ToLowerInvariant();
                                if (clean.EndsWith("." + domain.ToLowerInvariant()) || clean == domain.ToLowerInvariant())
                                    if (clean.Length < 253)
                                        found.Add(clean);
                            }
                        }
                    }
                }
            }
            catch { /* crt.sh failure is non-fatal */ }

            // Common subdomain wordlist probe (DNS resolution)
            var semaphore = new SemaphoreSlim(20, 20);
            var tasks = CommonSubdomains.Select(async sub =>
            {
                await semaphore.WaitAsync();
                try
                {
                    var fqdn = $"{sub}.{domain}";
                    var addrs = await Dns.GetHostAddressesAsync(fqdn).WaitAsync(TimeSpan.FromSeconds(3));
                    if (addrs.Length > 0) lock (found) { found.Add(fqdn.ToLowerInvariant()); }
                }
                catch { }
                finally { semaphore.Release(); }
            });
            await Task.WhenAll(tasks);

            var sorted = found.OrderBy(s => s).ToList();
            var suggestions = sorted
                .Where(s => !string.Equals(s, domain, StringComparison.OrdinalIgnoreCase))
                .Select(s => new EntitySuggestion { Type = "domain", Label = s, RelationLabel = "subdomain of" })
                .ToList();

            return new OsintQueryResult { Success = true, Data = new { total = sorted.Count, subdomains = sorted }, Suggestions = suggestions };
        }
        catch (Exception ex)
        {
            return new OsintQueryResult { Success = false, Error = ex.Message };
        }
    }

    // ── WHOIS via RDAP ───────────────────────────────────────────────────────

    public async Task<OsintQueryResult> WhoisAsync(string target)
    {
        try
        {
            using var client = MakeClient();
            // RDAP.org is a bootstrap that redirects to the correct RDAP server
            var url = $"https://rdap.org/domain/{Uri.EscapeDataString(target)}";
            var resp = await client.GetAsync(url);
            if (!resp.IsSuccessStatusCode)
                return new OsintQueryResult { Success = false, Error = $"RDAP returned {(int)resp.StatusCode}" };

            var raw = await resp.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;

            var data = new Dictionary<string, object?>();
            var suggestions = new List<EntitySuggestion>();

            // Nameservers
            var nameservers = new List<string>();
            if (root.TryGetProperty("nameservers", out var ns))
                foreach (var nsEl in ns.EnumerateArray())
                    if (nsEl.TryGetProperty("ldhName", out var nsName))
                    {
                        var nsHost = nsName.GetString()?.TrimEnd('.');
                        if (!string.IsNullOrEmpty(nsHost))
                        {
                            nameservers.Add(nsHost);
                            suggestions.Add(new EntitySuggestion { Type = "domain", Label = nsHost, RelationLabel = "nameserver" });
                        }
                    }
            if (nameservers.Count > 0) data["nameservers"] = nameservers;

            // Events (dates)
            var events = new Dictionary<string, string>();
            if (root.TryGetProperty("events", out var evts))
                foreach (var ev in evts.EnumerateArray())
                    if (ev.TryGetProperty("eventAction", out var action) && ev.TryGetProperty("eventDate", out var date))
                        events[action.GetString() ?? ""] = date.GetString() ?? "";
            if (events.Count > 0) data["events"] = events;

            // Entities (registrar, registrant, etc.)
            if (root.TryGetProperty("entities", out var entities))
            {
                foreach (var entity in entities.EnumerateArray())
                {
                    var roles = entity.TryGetProperty("roles", out var r)
                        ? r.EnumerateArray().Select(x => x.GetString()).ToList()
                        : [];
                    var role = string.Join(", ", roles);

                    if (!entity.TryGetProperty("vcardArray", out var vcard)) continue;
                    var fields = ExtractVcard(vcard);

                    if (fields.TryGetValue("fn", out var fn) && !string.IsNullOrEmpty(fn))
                        data[$"{role}_name"] = fn;

                    if (fields.TryGetValue("email", out var email) && !string.IsNullOrEmpty(email))
                    {
                        data[$"{role}_email"] = email;
                        if (roles.Contains("registrant") || roles.Contains("administrative"))
                            suggestions.Add(new EntitySuggestion { Type = "email", Label = email, RelationLabel = $"{role} email" });
                    }

                    if (fields.TryGetValue("org", out var org) && !string.IsNullOrEmpty(org))
                    {
                        data[$"{role}_org"] = org;
                        if (roles.Contains("registrant"))
                            suggestions.Add(new EntitySuggestion { Type = "org", Label = org, RelationLabel = "registrant org" });
                    }
                }
            }

            return new OsintQueryResult { Success = true, Data = data, Suggestions = suggestions };
        }
        catch (Exception ex)
        {
            return new OsintQueryResult { Success = false, Error = ex.Message };
        }
    }

    private static Dictionary<string, string> ExtractVcard(JsonElement vcardArray)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            if (vcardArray.ValueKind != JsonValueKind.Array) return result;
            var arr = vcardArray.EnumerateArray().ToList();
            if (arr.Count < 2) return result;
            foreach (var field in arr[1].EnumerateArray())
            {
                var parts = field.EnumerateArray().ToList();
                if (parts.Count < 4) continue;
                var name = parts[0].GetString()?.ToLowerInvariant() ?? "";
                var value = parts[3].ValueKind == JsonValueKind.String ? parts[3].GetString() : parts[3].ToString();
                if (!string.IsNullOrEmpty(name) && !string.IsNullOrEmpty(value))
                    result.TryAdd(name, value);
            }
        }
        catch { }
        return result;
    }

    // ── IP info (ipinfo.io) ──────────────────────────────────────────────────

    public async Task<OsintQueryResult> IpInfoAsync(string ip)
    {
        try
        {
            using var client = MakeClient();
            var resp = await client.GetAsync($"https://ipinfo.io/{Uri.EscapeDataString(ip)}/json");
            if (!resp.IsSuccessStatusCode)
                return new OsintQueryResult { Success = false, Error = $"ipinfo.io returned {(int)resp.StatusCode}" };

            var info = await resp.Content.ReadFromJsonAsync<IpInfoResponse>(_json);
            if (info == null) return new OsintQueryResult { Success = false, Error = "Empty response" };

            var suggestions = new List<EntitySuggestion>();

            if (!string.IsNullOrEmpty(info.Hostname))
                suggestions.Add(new EntitySuggestion { Type = "domain", Label = info.Hostname, RelationLabel = "PTR / rDNS" });

            if (!string.IsNullOrEmpty(info.Org))
            {
                var orgName = info.Org.Contains(' ') ? string.Join(' ', info.Org.Split(' ').Skip(1)) : info.Org;
                suggestions.Add(new EntitySuggestion { Type = "org", Label = orgName, RelationLabel = "hosting org", Extra = info.Org });
            }

            return new OsintQueryResult { Success = true, Data = info, Suggestions = suggestions };
        }
        catch (Exception ex)
        {
            return new OsintQueryResult { Success = false, Error = ex.Message };
        }
    }

    // ── Shodan ───────────────────────────────────────────────────────────────

    public async Task<OsintQueryResult> ShodanAsync(string ip)
    {
        var key = config["Osint:ShodanApiKey"];
        if (string.IsNullOrWhiteSpace(key))
            return new OsintQueryResult { Success = false, Error = "Shodan API key not configured (set Osint:ShodanApiKey in appsettings.json)" };

        try
        {
            using var client = MakeClient();
            var resp = await client.GetAsync($"https://api.shodan.io/shodan/host/{Uri.EscapeDataString(ip)}?key={key}");
            if (resp.StatusCode == HttpStatusCode.NotFound)
                return new OsintQueryResult { Success = true, Data = new { message = "No Shodan data for this IP" }, Suggestions = [] };
            if (!resp.IsSuccessStatusCode)
                return new OsintQueryResult { Success = false, Error = $"Shodan API returned {(int)resp.StatusCode}" };

            var raw = await resp.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;

            var data = new Dictionary<string, object?>();
            var suggestions = new List<EntitySuggestion>();

            if (root.TryGetProperty("org", out var org)) data["org"] = org.GetString();
            if (root.TryGetProperty("isp", out var isp)) data["isp"] = isp.GetString();
            if (root.TryGetProperty("asn", out var asn)) data["asn"] = asn.GetString();
            if (root.TryGetProperty("country_name", out var country)) data["country"] = country.GetString();
            if (root.TryGetProperty("city", out var city)) data["city"] = city.GetString();

            if (root.TryGetProperty("hostnames", out var hostnames))
            {
                var hn = hostnames.EnumerateArray().Select(h => h.GetString()).Where(h => h != null).ToList();
                data["hostnames"] = hn;
                foreach (var h in hn)
                    if (!string.IsNullOrEmpty(h))
                        suggestions.Add(new EntitySuggestion { Type = "domain", Label = h!, RelationLabel = "Shodan hostname" });
            }

            if (root.TryGetProperty("ports", out var ports))
                data["ports"] = ports.EnumerateArray().Select(p => p.GetInt32()).OrderBy(p => p).ToList();

            if (root.TryGetProperty("vulns", out var vulns))
            {
                var cves = vulns.EnumerateObject().Select(v => v.Name).ToList();
                data["cves"] = cves;
            }

            var services = new List<Dictionary<string, object?>>();
            if (root.TryGetProperty("data", out var svcData))
            {
                foreach (var svc in svcData.EnumerateArray())
                {
                    var entry = new Dictionary<string, object?>();
                    if (svc.TryGetProperty("port", out var port)) entry["port"] = port.GetInt32();
                    if (svc.TryGetProperty("transport", out var transport)) entry["transport"] = transport.GetString();
                    if (svc.TryGetProperty("product", out var product)) entry["product"] = product.GetString();
                    if (svc.TryGetProperty("version", out var version)) entry["version"] = version.GetString();
                    if (svc.TryGetProperty("cpe", out var cpe)) entry["cpe"] = cpe.ToString();
                    if (svc.TryGetProperty("http", out var http) && http.TryGetProperty("title", out var title))
                        entry["http_title"] = title.GetString();
                    if (svc.TryGetProperty("ssl", out var ssl) && ssl.TryGetProperty("cert", out var cert)
                        && cert.TryGetProperty("subject", out var subj) && subj.TryGetProperty("CN", out var cn))
                        entry["tls_cn"] = cn.GetString();
                    services.Add(entry);
                }
            }
            if (services.Count > 0) data["services"] = services;

            return new OsintQueryResult { Success = true, Data = data, Suggestions = suggestions };
        }
        catch (Exception ex)
        {
            return new OsintQueryResult { Success = false, Error = ex.Message };
        }
    }

    // ── HIBP ─────────────────────────────────────────────────────────────────

    public async Task<OsintQueryResult> HibpAsync(string email)
    {
        var key = config["Osint:HibpApiKey"];
        if (string.IsNullOrWhiteSpace(key))
            return new OsintQueryResult { Success = false, Error = "HIBP API key not configured (set Osint:HibpApiKey in appsettings.json)" };

        try
        {
            using var client = MakeClient();
            client.DefaultRequestHeaders.Add("hibp-api-key", key);
            client.DefaultRequestHeaders.Add("Accept", "application/vnd.haveibeenpwned.v3+json");

            var url = $"https://haveibeenpwned.com/api/v3/breachedaccount/{Uri.EscapeDataString(email)}?truncateResponse=false";
            var resp = await client.GetAsync(url);

            if (resp.StatusCode == HttpStatusCode.NotFound)
                return new OsintQueryResult { Success = true, Data = new { breaches = Array.Empty<object>(), summary = "No breaches found" }, Suggestions = [] };

            if (!resp.IsSuccessStatusCode)
                return new OsintQueryResult { Success = false, Error = $"HIBP returned {(int)resp.StatusCode}" };

            var breaches = await resp.Content.ReadFromJsonAsync<List<HibpBreach>>(_json);
            if (breaches == null) return new OsintQueryResult { Success = true, Data = new { breaches = Array.Empty<object>() }, Suggestions = [] };

            var summary = breaches.Select(b => new
            {
                b.Name,
                b.Title,
                b.Domain,
                b.BreachDate,
                PwnCount = b.PwnCount,
                b.IsVerified,
                b.DataClasses
            }).ToList();

            var totalPwned = breaches.Sum(b => (long)b.PwnCount);

            return new OsintQueryResult
            {
                Success = true,
                Data = new { breachCount = breaches.Count, totalRecords = totalPwned, breaches = summary },
                Suggestions = []
            };
        }
        catch (Exception ex)
        {
            return new OsintQueryResult { Success = false, Error = ex.Message };
        }
    }

    // ── Username correlation ─────────────────────────────────────────────────

    private static readonly (string Platform, string UrlTemplate, bool SpecialCheck)[] Platforms =
    [
        ("GitHub",          "https://github.com/{0}",                                false),
        ("GitLab",          "https://gitlab.com/{0}",                                false),
        ("Bitbucket",       "https://bitbucket.org/{0}",                             false),
        ("Reddit",          "https://www.reddit.com/user/{0}/about.json",            false),
        ("HackerNews",      "https://hacker-news.firebaseio.com/v0/user/{0}.json",   true),
        ("Keybase",         "https://keybase.io/{0}",                                false),
        ("Dev.to",          "https://dev.to/{0}",                                    false),
        ("Medium",          "https://medium.com/@{0}",                               false),
        ("Steam",           "https://steamcommunity.com/id/{0}",                     false),
        ("Twitch",          "https://www.twitch.tv/{0}",                             false),
        ("YouTube",         "https://www.youtube.com/@{0}",                          false),
        ("TikTok",          "https://www.tiktok.com/@{0}",                           false),
        ("Pinterest",       "https://www.pinterest.com/{0}/",                        false),
        ("Telegram",        "https://t.me/{0}",                                      false),
        ("Twitter/X",       "https://twitter.com/{0}",                               false),
        ("Instagram",       "https://www.instagram.com/{0}/",                        false),
        ("Mastodon infosec","https://infosec.exchange/@{0}",                         false),
        ("Mastodon social", "https://mastodon.social/@{0}",                          false),
        ("DockerHub",       "https://hub.docker.com/u/{0}",                          false),
        ("PyPI",            "https://pypi.org/user/{0}/",                            false),
        ("npm",             "https://www.npmjs.com/~{0}",                            false),
        ("Gravatar",        "https://gravatar.com/{0}",                              false),
        ("Sourceforge",     "https://sourceforge.net/u/{0}/profile/",               false),
    ];

    public async Task<OsintQueryResult> UsernamesAsync(string username)
    {
        try
        {
            var semaphore = new SemaphoreSlim(8, 8);
            var results = new List<(string Platform, string Url, string Status)>();
            var resultsLock = new object();

            var tasks = Platforms.Select(async p =>
            {
                await semaphore.WaitAsync();
                var url = string.Format(p.UrlTemplate, Uri.EscapeDataString(username));
                var status = "unknown";
                try
                {
                    using var client = MakeClient(6);
                    client.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent",
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
                    var resp = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
                    if (p.SpecialCheck)
                    {
                        // HackerNews returns 200 with "null" body for missing users
                        var body = await resp.Content.ReadAsStringAsync();
                        status = (resp.IsSuccessStatusCode && body != "null") ? "found" : "not_found";
                    }
                    else
                    {
                        status = resp.StatusCode switch
                        {
                            HttpStatusCode.OK => "found",
                            HttpStatusCode.NotFound => "not_found",
                            HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized => "blocked",
                            HttpStatusCode.TooManyRequests => "rate_limited",
                            _ => $"http_{(int)resp.StatusCode}"
                        };
                    }
                }
                catch (TaskCanceledException) { status = "timeout"; }
                catch { status = "error"; }
                finally { semaphore.Release(); }

                lock (resultsLock)
                    results.Add((p.Platform, url, status));
            });

            await Task.WhenAll(tasks);

            var sorted = results.OrderBy(r => r.Platform).ToList();
            var found = sorted.Where(r => r.Status == "found").ToList();

            var suggestions = found
                .Select(r => new EntitySuggestion
                {
                    Type = "url",
                    Label = r.Url,
                    RelationLabel = $"profile on {r.Platform}",
                    Extra = r.Platform
                }).ToList();

            return new OsintQueryResult
            {
                Success = true,
                Data = new
                {
                    username,
                    foundCount = found.Count,
                    results = sorted.Select(r => new { r.Platform, r.Url, r.Status })
                },
                Suggestions = suggestions
            };
        }
        catch (Exception ex)
        {
            return new OsintQueryResult { Success = false, Error = ex.Message };
        }
    }

    // ── Private record types for JSON deserialization ────────────────────────

    private record DohResponse(
        [property: JsonPropertyName("Status")] int Status,
        [property: JsonPropertyName("Answer")] List<DohAnswer>? Answer
    );

    private record DohAnswer(
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("type")] int Type,
        [property: JsonPropertyName("TTL")] int Ttl,
        [property: JsonPropertyName("data")] string Data
    );

    private record CrtShEntry(
        [property: JsonPropertyName("name_value")] string? NameValue,
        [property: JsonPropertyName("common_name")] string? CommonName
    );

    private record IpInfoResponse(
        string? Ip, string? Hostname, string? City, string? Region,
        string? Country, string? Loc, string? Org, string? Postal, string? Timezone
    );

    private record HibpBreach(
        string? Name, string? Title, string? Domain, string? BreachDate,
        int PwnCount, bool IsVerified,
        [property: JsonPropertyName("DataClasses")] List<string>? DataClasses
    );
}
