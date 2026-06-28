using InkNote.Data;
using InkNote.Models;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace InkNote.Controllers;

[ApiController]
[Route("api/investigations")]
public class InvestigationsController(AppDbContext db) : ControllerBase
{
    // ── Investigation CRUD ───────────────────────────────────────────────────

    [HttpGet]
    public async Task<IActionResult> GetAll()
    {
        var list = await db.Investigations
            .OrderByDescending(i => i.UpdatedAt)
            .Select(i => new InvestigationDto(i.Id, i.Name, i.Description, i.CreatedAt, i.UpdatedAt))
            .ToListAsync();
        return Ok(list);
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateInvestigationRequest req)
    {
        var inv = new Investigation { Name = req.Name, Description = req.Description };
        db.Investigations.Add(inv);
        await db.SaveChangesAsync();
        return Ok(new InvestigationDto(inv.Id, inv.Name, inv.Description, inv.CreatedAt, inv.UpdatedAt));
    }

    [HttpGet("{id}")]
    public async Task<IActionResult> Get(int id)
    {
        var inv = await db.Investigations
            .Include(i => i.Entities)
            .Include(i => i.Relations)
            .FirstOrDefaultAsync(i => i.Id == id);
        if (inv == null) return NotFound();

        return Ok(new InvestigationDetailDto(
            inv.Id, inv.Name, inv.Description, inv.CreatedAt, inv.UpdatedAt,
            inv.Entities.Select(e => ToDto(e)).ToList(),
            inv.Relations.Select(r => ToDto(r)).ToList()
        ));
    }

    [HttpPut("{id}")]
    public async Task<IActionResult> Update(int id, [FromBody] CreateInvestigationRequest req)
    {
        var inv = await db.Investigations.FindAsync(id);
        if (inv == null) return NotFound();
        inv.Name = req.Name;
        inv.Description = req.Description;
        inv.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();
        return Ok(new InvestigationDto(inv.Id, inv.Name, inv.Description, inv.CreatedAt, inv.UpdatedAt));
    }

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(int id)
    {
        var inv = await db.Investigations.FindAsync(id);
        if (inv == null) return NotFound();
        db.Investigations.Remove(inv);
        await db.SaveChangesAsync();
        return NoContent();
    }

    // ── Drawing (canvas notes per investigation) ─────────────────────────────

    [HttpGet("{id}/drawing")]
    public async Task<IActionResult> GetDrawing(int id)
    {
        var inv = await db.Investigations.FindAsync(id);
        if (inv == null) return NotFound();
        if (inv.DrawingData == null) return Ok(new { data = (string?)null });
        return Ok(new { data = Convert.ToBase64String(inv.DrawingData) });
    }

    [HttpPut("{id}/drawing")]
    public async Task<IActionResult> SaveDrawing(int id, [FromBody] SaveDrawingRequest req)
    {
        var inv = await db.Investigations.FindAsync(id);
        if (inv == null) return NotFound();
        inv.DrawingData = Convert.FromBase64String(req.CompressedData);
        inv.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();
        return Ok();
    }

    // ── Entity CRUD ──────────────────────────────────────────────────────────

    [HttpPost("{id}/entities")]
    public async Task<IActionResult> AddEntity(int id, [FromBody] CreateInvEntityRequest req)
    {
        if (!await db.Investigations.AnyAsync(i => i.Id == id)) return NotFound();
        var entity = new InvEntity
        {
            InvestigationId = id,
            Type = req.Type,
            Label = req.Label,
            X = req.X,
            Y = req.Y,
            Notes = req.Notes
        };
        db.InvEntities.Add(entity);
        await db.SaveChangesAsync();
        return Ok(ToDto(entity));
    }

    [HttpPut("{id}/entities/{eid}")]
    public async Task<IActionResult> UpdateEntity(int id, int eid, [FromBody] UpdateInvEntityRequest req)
    {
        var entity = await db.InvEntities.FirstOrDefaultAsync(e => e.Id == eid && e.InvestigationId == id);
        if (entity == null) return NotFound();

        if (req.Label != null) entity.Label = req.Label;
        if (req.Notes != null) entity.Notes = req.Notes;
        if (req.X.HasValue) entity.X = req.X.Value;
        if (req.Y.HasValue) entity.Y = req.Y.Value;
        if (req.OsintJson != null) entity.OsintJson = req.OsintJson;
        entity.UpdatedAt = DateTime.UtcNow;

        var inv = await db.Investigations.FindAsync(id);
        if (inv != null) inv.UpdatedAt = DateTime.UtcNow;

        await db.SaveChangesAsync();
        return Ok(ToDto(entity));
    }

    [HttpDelete("{id}/entities/{eid}")]
    public async Task<IActionResult> DeleteEntity(int id, int eid)
    {
        var entity = await db.InvEntities.FirstOrDefaultAsync(e => e.Id == eid && e.InvestigationId == id);
        if (entity == null) return NotFound();

        // Remove all relations that reference this entity
        var relations = await db.InvRelations
            .Where(r => r.InvestigationId == id && (r.SourceId == eid || r.TargetId == eid))
            .ToListAsync();
        db.InvRelations.RemoveRange(relations);
        db.InvEntities.Remove(entity);
        await db.SaveChangesAsync();
        return NoContent();
    }

    // ── Relation CRUD ────────────────────────────────────────────────────────

    [HttpPost("{id}/relations")]
    public async Task<IActionResult> AddRelation(int id, [FromBody] CreateInvRelationRequest req)
    {
        if (!await db.Investigations.AnyAsync(i => i.Id == id)) return NotFound();
        if (!await db.InvEntities.AnyAsync(e => e.Id == req.SourceId && e.InvestigationId == id)) return BadRequest("Source entity not found");
        if (!await db.InvEntities.AnyAsync(e => e.Id == req.TargetId && e.InvestigationId == id)) return BadRequest("Target entity not found");

        var relation = new InvRelation
        {
            InvestigationId = id,
            SourceId = req.SourceId,
            TargetId = req.TargetId,
            Label = req.Label
        };
        db.InvRelations.Add(relation);
        await db.SaveChangesAsync();
        return Ok(ToDto(relation));
    }

    [HttpDelete("{id}/relations/{rid}")]
    public async Task<IActionResult> DeleteRelation(int id, int rid)
    {
        var rel = await db.InvRelations.FirstOrDefaultAsync(r => r.Id == rid && r.InvestigationId == id);
        if (rel == null) return NotFound();
        db.InvRelations.Remove(rel);
        await db.SaveChangesAsync();
        return NoContent();
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private static InvEntityDto ToDto(InvEntity e) =>
        new(e.Id, e.InvestigationId, e.Type, e.Label, e.Notes, e.OsintJson, e.X, e.Y);

    private static InvRelationDto ToDto(InvRelation r) =>
        new(r.Id, r.InvestigationId, r.SourceId, r.TargetId, r.Label);
}
