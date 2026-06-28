using InkNote.Models;
using Microsoft.EntityFrameworkCore;

namespace InkNote.Data;

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<Notebook> Notebooks => Set<Notebook>();
    public DbSet<Page> Pages => Set<Page>();
    public DbSet<Investigation> Investigations => Set<Investigation>();
    public DbSet<InvEntity> InvEntities => Set<InvEntity>();
    public DbSet<InvRelation> InvRelations => Set<InvRelation>();

    protected override void OnModelCreating(ModelBuilder mb)
    {
        mb.Entity<Notebook>().HasIndex(n => n.UpdatedAt);
        mb.Entity<Page>().HasIndex(p => p.NotebookId);
        mb.Entity<Page>().HasIndex(p => p.UpdatedAt);

        mb.Entity<Investigation>().HasIndex(i => i.UpdatedAt);
        mb.Entity<InvEntity>().HasIndex(e => e.InvestigationId);
        mb.Entity<InvRelation>().HasIndex(r => r.InvestigationId);

        mb.Entity<InvEntity>()
            .HasOne<Investigation>()
            .WithMany(i => i.Entities)
            .HasForeignKey(e => e.InvestigationId)
            .OnDelete(DeleteBehavior.Cascade);

        mb.Entity<InvRelation>()
            .HasOne<Investigation>()
            .WithMany(i => i.Relations)
            .HasForeignKey(r => r.InvestigationId)
            .OnDelete(DeleteBehavior.Cascade);

        // Source/target FK relationships are managed manually in the controller
        mb.Entity<InvRelation>()
            .HasOne<InvEntity>()
            .WithMany()
            .HasForeignKey(r => r.SourceId)
            .OnDelete(DeleteBehavior.NoAction);

        mb.Entity<InvRelation>()
            .HasOne<InvEntity>()
            .WithMany()
            .HasForeignKey(r => r.TargetId)
            .OnDelete(DeleteBehavior.NoAction);
    }
}
