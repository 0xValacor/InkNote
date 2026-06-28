using InkNote.Data;
using InkNote.Services;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlite(builder.Configuration.GetConnectionString("DefaultConnection")
        ?? "Data Source=inknote.db"));
builder.Services.AddHttpClient();
builder.Services.AddSingleton<OsintService>();

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.EnsureCreated();

    // Create investigation tables if the DB already existed before this feature was added
    db.Database.ExecuteSqlRaw(@"
        CREATE TABLE IF NOT EXISTS ""Investigations"" (
            ""Id"" INTEGER NOT NULL CONSTRAINT ""PK_Investigations"" PRIMARY KEY AUTOINCREMENT,
            ""Name"" TEXT NOT NULL,
            ""Description"" TEXT NULL,
            ""DrawingData"" BLOB NULL,
            ""CreatedAt"" TEXT NOT NULL,
            ""UpdatedAt"" TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ""IX_Investigations_UpdatedAt"" ON ""Investigations"" (""UpdatedAt"");

        CREATE TABLE IF NOT EXISTS ""InvEntities"" (
            ""Id"" INTEGER NOT NULL CONSTRAINT ""PK_InvEntities"" PRIMARY KEY AUTOINCREMENT,
            ""InvestigationId"" INTEGER NOT NULL,
            ""Type"" TEXT NOT NULL,
            ""Label"" TEXT NOT NULL,
            ""Notes"" TEXT NULL,
            ""OsintJson"" TEXT NULL,
            ""X"" REAL NOT NULL,
            ""Y"" REAL NOT NULL,
            ""CreatedAt"" TEXT NOT NULL,
            ""UpdatedAt"" TEXT NOT NULL,
            CONSTRAINT ""FK_InvEntities_Investigations"" FOREIGN KEY (""InvestigationId"")
                REFERENCES ""Investigations"" (""Id"") ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS ""IX_InvEntities_InvestigationId"" ON ""InvEntities"" (""InvestigationId"");

        CREATE TABLE IF NOT EXISTS ""InvRelations"" (
            ""Id"" INTEGER NOT NULL CONSTRAINT ""PK_InvRelations"" PRIMARY KEY AUTOINCREMENT,
            ""InvestigationId"" INTEGER NOT NULL,
            ""SourceId"" INTEGER NOT NULL,
            ""TargetId"" INTEGER NOT NULL,
            ""Label"" TEXT NULL,
            CONSTRAINT ""FK_InvRelations_Investigations"" FOREIGN KEY (""InvestigationId"")
                REFERENCES ""Investigations"" (""Id"") ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS ""IX_InvRelations_InvestigationId"" ON ""InvRelations"" (""InvestigationId"");
    ");
}

app.UseDefaultFiles();
app.UseStaticFiles();
app.MapControllers();

app.Run();
