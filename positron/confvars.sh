MOZ_APP_BASENAME=Positron
MOZ_APP_DISPLAYNAME=Positron
MOZ_APP_VERSION=$MOZILLA_VERSION

MOZ_APP_STATIC_INI=1
MOZ_CHROME_FILE_FORMAT=omni

#XXXkhuey I have no idea why startupcache doesn't work
MOZ_DISABLE_STARTUPCACHE=1

# Include the DevTools client, not just the server (which is the default).
MOZ_DEVTOOLS=all
