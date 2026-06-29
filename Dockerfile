FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY *.csproj ./
RUN dotnet restore
COPY . ./
RUN dotnet publish -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=build /app/publish .

# DB lives at /data/inknote.db so it can be bind-mounted from the host
ENV ConnectionStrings__DefaultConnection="Data Source=/data/inknote.db"
EXPOSE 5000
VOLUME /data
ENTRYPOINT ["dotnet", "InkNote.dll"]
