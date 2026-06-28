namespace InkNote.Models;

public class Notebook
{
    public int Id { get; set; }
    public string Name { get; set; } = "Untitled";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public List<Page> Pages { get; set; } = [];
}

public class Page
{
    public int Id { get; set; }
    public int NotebookId { get; set; }
    public string Title { get; set; } = "Untitled Page";
    public byte[]? DrawingData { get; set; } // GZip-compressed JSON
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public Notebook? Notebook { get; set; }
}

public record NotebookDto(int Id, string Name, DateTime CreatedAt, DateTime UpdatedAt);
public record PageDto(int Id, int NotebookId, string Title, DateTime CreatedAt, DateTime UpdatedAt);
public record CreateNotebookRequest(string Name);
public record CreatePageRequest(string Title);
public record UpdateTitleRequest(string Title);
public record SaveDrawingRequest(string CompressedData);
public record LinkPreviewResult(
    string Url,
    string? Title,
    string? Description,
    string? ImageUrl,
    string? SiteName,
    bool IsYoutube,
    string? YoutubeId
);

// ── OSINT Investigation graph ────────────────────────────────────────────────

public class Investigation
{
    public int Id { get; set; }
    public string Name { get; set; } = "Untitled Investigation";
    public string? Description { get; set; }
    public byte[]? DrawingData { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public List<InvEntity> Entities { get; set; } = [];
    public List<InvRelation> Relations { get; set; } = [];
}

public class InvEntity
{
    public int Id { get; set; }
    public int InvestigationId { get; set; }
    public string Type { get; set; } = "unknown"; // person | org | domain | ip | email | username | phone | url
    public string Label { get; set; } = "";
    public string? Notes { get; set; }
    public string? OsintJson { get; set; }
    public float X { get; set; }
    public float Y { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class InvRelation
{
    public int Id { get; set; }
    public int InvestigationId { get; set; }
    public int SourceId { get; set; }
    public int TargetId { get; set; }
    public string? Label { get; set; }
}

public record InvestigationDto(int Id, string Name, string? Description, DateTime CreatedAt, DateTime UpdatedAt);
public record InvestigationDetailDto(
    int Id, string Name, string? Description,
    DateTime CreatedAt, DateTime UpdatedAt,
    List<InvEntityDto> Entities,
    List<InvRelationDto> Relations
);
public record InvEntityDto(int Id, int InvestigationId, string Type, string Label, string? Notes, string? OsintJson, float X, float Y);
public record InvRelationDto(int Id, int InvestigationId, int SourceId, int TargetId, string? Label);
public record CreateInvestigationRequest(string Name, string? Description = null);
public record CreateInvEntityRequest(string Type, string Label, float X = 0, float Y = 0, string? Notes = null);
public record UpdateInvEntityRequest(string? Label, string? Notes, float? X, float? Y, string? OsintJson);
public record CreateInvRelationRequest(int SourceId, int TargetId, string? Label = null);
