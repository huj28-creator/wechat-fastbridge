#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>

static id AXAttr(AXUIElementRef element, CFStringRef name) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess || !value) return nil;
    return CFBridgingRelease(value);
}

static NSString *AXString(AXUIElementRef element, CFStringRef name) {
    id value = AXAttr(element, name);
    return [value isKindOfClass:NSString.class] && [value length] ? value : nil;
}

static BOOL AXBool(AXUIElementRef element, CFStringRef name) {
    id value = AXAttr(element, name);
    return [value respondsToSelector:@selector(boolValue)] ? [value boolValue] : NO;
}

static NSRect AXFrame(AXUIElementRef element) {
    AXValueRef position = (__bridge AXValueRef)AXAttr(element, kAXPositionAttribute);
    AXValueRef size = (__bridge AXValueRef)AXAttr(element, kAXSizeAttribute);
    CGPoint point = CGPointZero;
    CGSize dimensions = CGSizeZero;
    if (!position || !size || !AXValueGetValue(position, kAXValueCGPointType, &point) || !AXValueGetValue(size, kAXValueCGSizeType, &dimensions)) return NSZeroRect;
    return NSMakeRect(point.x, point.y, dimensions.width, dimensions.height);
}

static NSArray<NSString *> *AXStrings(AXUIElementRef element) {
    NSMutableOrderedSet<NSString *> *values = [NSMutableOrderedSet orderedSet];
    for (id name in @[(__bridge id)kAXValueAttribute, (__bridge id)kAXTitleAttribute, (__bridge id)kAXDescriptionAttribute, (__bridge id)kAXHelpAttribute]) {
        NSString *value = AXString(element, (__bridge CFStringRef)name);
        if (value.length) [values addObject:value];
    }
    return values.array;
}

static NSArray *AXChildren(AXUIElementRef element) {
    id value = AXAttr(element, kAXChildrenAttribute);
    return [value isKindOfClass:NSArray.class] ? value : @[];
}

static NSDictionary *LegacyNode(AXUIElementRef element) {
    NSString *role = AXString(element, kAXRoleAttribute) ?: @"";
    BOOL rowOrCell = [role isEqualToString:(__bridge NSString *)kAXRowRole] || [role isEqualToString:(__bridge NSString *)kAXCellRole];
    BOOL textInput = [role isEqualToString:(__bridge NSString *)kAXTextAreaRole] || [role isEqualToString:(__bridge NSString *)kAXTextFieldRole];
    BOOL needsStrings = YES;
    Boolean settable = false;
    if (textInput) AXUIElementIsAttributeSettable(element, kAXValueAttribute, &settable);
    return @{
        @"element": (__bridge id)element, @"role": role,
        @"strings": needsStrings ? AXStrings(element) : @[],
        @"selected": @(rowOrCell ? AXBool(element, kAXSelectedAttribute) : NO),
        @"settable": @(settable), @"frame": [NSValue valueWithRect:AXFrame(element)],
    };
}

static NSDictionary *NodeAndChildren(AXUIElementRef element, NSArray **childrenOut) {
    NSArray *attributes = @[
        (__bridge id)kAXRoleAttribute, (__bridge id)kAXChildrenAttribute,
        (__bridge id)kAXValueAttribute, (__bridge id)kAXTitleAttribute,
        (__bridge id)kAXDescriptionAttribute, (__bridge id)kAXHelpAttribute,
        (__bridge id)kAXSelectedAttribute, (__bridge id)kAXPositionAttribute,
        (__bridge id)kAXSizeAttribute,
    ];
    CFArrayRef copied = NULL;
    AXError error = AXUIElementCopyMultipleAttributeValues(
        element, (__bridge CFArrayRef)attributes, 0, &copied
    );
    if (error != kAXErrorSuccess || !copied) {
        if (childrenOut) *childrenOut = AXChildren(element);
        return LegacyNode(element);
    }
    NSArray *values = CFBridgingRelease(copied);
    id (^at)(NSUInteger) = ^id(NSUInteger index) {
        if (index >= values.count) return nil;
        id value = values[index];
        return value == NSNull.null ? nil : value;
    };
    NSString *role = [at(0) isKindOfClass:NSString.class] ? at(0) : @"";
    NSArray *children = [at(1) isKindOfClass:NSArray.class] ? at(1) : @[];
    if (childrenOut) *childrenOut = children;
    BOOL rowOrCell = [role isEqualToString:(__bridge NSString *)kAXRowRole] || [role isEqualToString:(__bridge NSString *)kAXCellRole];
    BOOL textInput = [role isEqualToString:(__bridge NSString *)kAXTextAreaRole] || [role isEqualToString:(__bridge NSString *)kAXTextFieldRole];
    BOOL needsStrings = YES;
    NSMutableOrderedSet *strings = [NSMutableOrderedSet orderedSet];
    if (needsStrings) for (NSUInteger index = 2; index <= 5; index++) {
        id value = at(index);
        if ([value isKindOfClass:NSString.class] && [value length]) [strings addObject:value];
    }
    CGPoint point = CGPointZero;
    CGSize dimensions = CGSizeZero;
    id position = at(7);
    id size = at(8);
    if (position && CFGetTypeID((__bridge CFTypeRef)position) == AXValueGetTypeID()) AXValueGetValue((__bridge AXValueRef)position, kAXValueCGPointType, &point);
    if (size && CFGetTypeID((__bridge CFTypeRef)size) == AXValueGetTypeID()) AXValueGetValue((__bridge AXValueRef)size, kAXValueCGSizeType, &dimensions);
    Boolean settable = false;
    if (textInput) AXUIElementIsAttributeSettable(element, kAXValueAttribute, &settable);
    return @{
        @"element": (__bridge id)element,
        @"role": role,
        @"strings": strings.array,
        @"selected": @(rowOrCell && [at(6) respondsToSelector:@selector(boolValue)] ? [at(6) boolValue] : NO),
        @"settable": @(settable),
        @"frame": [NSValue valueWithRect:NSMakeRect(point.x, point.y, dimensions.width, dimensions.height)],
    };
}

static NSArray<NSDictionary *> *WalkMode(AXUIElementRef root, NSUInteger limit, NSInteger pruneMode, CGFloat splitX) {
    NSMutableArray *queue = [NSMutableArray arrayWithObject:(__bridge id)root];
    NSMutableArray *nodes = [NSMutableArray array];
    for (NSUInteger cursor = 0; cursor < queue.count && nodes.count < limit; cursor++) {
        AXUIElementRef element = (__bridge AXUIElementRef)queue[cursor];
        NSArray *children = nil;
        NSDictionary *node = NodeAndChildren(element, &children);
        [nodes addObject:node];
        NSString *role = node[@"role"];
        NSRect frame = [node[@"frame"] rectValue];
        BOOL rowOrCell = [role isEqualToString:(__bridge NSString *)kAXRowRole] ||
                         [role isEqualToString:(__bridge NSString *)kAXCellRole];
        BOOL prune = rowOrCell && (pruneMode == 1 || (pruneMode == 2 && NSMidX(frame) < splitX));
        if (!prune) [queue addObjectsFromArray:children ?: @[]];
    }
    return nodes;
}

static NSArray<NSDictionary *> *Walk(AXUIElementRef root, NSUInteger limit) {
    return WalkMode(root, limit, 0, 0);
}

static NSArray<NSString *> *SubtreeStrings(AXUIElementRef element) {
    NSMutableOrderedSet *values = [NSMutableOrderedSet orderedSet];
    for (NSDictionary *node in Walk(element, 100)) [values addObjectsFromArray:node[@"strings"]];
    return values.array;
}

static NSString *NormalizeChatName(NSString *value) {
    if (!value.length) return @"";
    NSString *trimmed = [value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    NSRegularExpression *count = [NSRegularExpression regularExpressionWithPattern:@"\\s*[（(]\\s*\\d+\\s*[)）]\\s*$" options:0 error:nil];
    trimmed = [count stringByReplacingMatchesInString:trimmed options:0 range:NSMakeRange(0, trimmed.length) withTemplate:@""];
    NSMutableString *normalized = [NSMutableString string];
    NSCharacterSet *kept = [NSCharacterSet.alphanumericCharacterSet invertedSet];
    NSString *folded = [trimmed precomposedStringWithCompatibilityMapping].lowercaseString;
    [folded enumerateSubstringsInRange:NSMakeRange(0, folded.length)
                               options:NSStringEnumerationByComposedCharacterSequences
                            usingBlock:^(NSString *part, NSRange range, NSRange enclosing, BOOL *stop) {
        if ([part rangeOfCharacterFromSet:kept].location == NSNotFound) [normalized appendString:part];
    }];
    return normalized;
}

static NSUInteger ChatNameDistance(NSString *left, NSString *right) {
    NSUInteger a = left.length, b = right.length;
    if (!a) return b;
    if (!b) return a;
    NSUInteger *previous = calloc(b + 1, sizeof(NSUInteger));
    NSUInteger *current = calloc(b + 1, sizeof(NSUInteger));
    for (NSUInteger j = 0; j <= b; j++) previous[j] = j;
    for (NSUInteger i = 1; i <= a; i++) {
        current[0] = i;
        for (NSUInteger j = 1; j <= b; j++) {
            NSUInteger replace = previous[j - 1] + ([left characterAtIndex:i - 1] == [right characterAtIndex:j - 1] ? 0 : 1);
            current[j] = MIN(MIN(previous[j] + 1, current[j - 1] + 1), replace);
        }
        NSUInteger *swap = previous; previous = current; current = swap;
    }
    NSUInteger result = previous[b];
    free(previous); free(current);
    return result;
}

static BOOL ChatNameMatches(NSString *value, NSString *chat) {
    if ([value isEqualToString:chat]) return YES;
    NSString *candidate = NormalizeChatName(value);
    NSString *requested = NormalizeChatName(chat);
    if (!candidate.length || !requested.length) return NO;
    if ([candidate isEqualToString:requested]) return YES;
    NSUInteger shortest = MIN(candidate.length, requested.length);
    if (shortest < 3) return NO;
    NSUInteger allowed = shortest <= 5 ? 1 : (shortest <= 10 ? 2 : MIN((NSUInteger)3, MAX((NSUInteger)2, shortest / 5)));
    return ChatNameDistance(candidate, requested) <= allowed;
}

static BOOL RowTitleMatches(NSString *value, NSString *chat) {
    if ([value isEqualToString:chat] || [value hasPrefix:[chat stringByAppendingString:@","]]) return YES;
    if (ChatNameMatches(value, chat)) return YES;
    NSRange separator = [value rangeOfString:@","];
    return separator.location != NSNotFound && ChatNameMatches([value substringToIndex:separator.location], chat);
}

static NSString *FNV1a(NSString *value);

static NSDictionary *InboxEntry(NSArray<NSString *> *strings, BOOL selected) {
    if (!strings.count) return nil;
    NSString *joined = [strings componentsJoinedByString:@" | "];
    NSString *title = @"";
    NSString *preview = @"";
    for (NSString *value in strings) {
        NSRange separator = [value rangeOfString:@","];
        if (separator.location != NSNotFound) {
            title = [[value substringToIndex:separator.location] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
            NSArray<NSString *> *parts = [value componentsSeparatedByString:@","];
            if (parts.count > 1) preview = [parts[1] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
            break;
        }
    }
    if (!title.length && strings.count > 1) {
        title = [strings[0] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        preview = [strings[1] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    }
    if (!title.length || [title isEqualToString:@"会话"] || [title isEqualToString:@"消息"]) return nil;
    if (preview.length > 160) preview = [[preview substringToIndex:159] stringByAppendingString:@"…"];
    NSRegularExpression *unreadPattern = [NSRegularExpression regularExpressionWithPattern:@"(\\d+)条未读" options:0 error:nil];
    NSTextCheckingResult *unreadMatch = [unreadPattern firstMatchInString:joined options:0 range:NSMakeRange(0, joined.length)];
    NSInteger unread = unreadMatch.numberOfRanges > 1 ? [[joined substringWithRange:[unreadMatch rangeAtIndex:1]] integerValue] : 0;
    NSString *signature = FNV1a([NSString stringWithFormat:@"%@\n%@\n%ld", NormalizeChatName(title), preview, (long)unread]);
    return @{ @"chat": title, @"preview": preview, @"unread": @(unread), @"selected": @(selected), @"signature": signature };
}

static NSString *FNV1a(NSString *value) {
    uint32_t hash = 2166136261u;
    NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
    const uint8_t *bytes = data.bytes;
    for (NSUInteger i = 0; i < data.length; i++) hash = (hash ^ bytes[i]) * 16777619u;
    return [NSString stringWithFormat:@"%08x", hash];
}

static BOOL IsMessageNoise(NSString *value, NSString *chat) {
    NSString *trimmed = [value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (!trimmed.length || [trimmed isEqualToString:@"Field"] || ChatNameMatches(trimmed, chat)) return YES;
    NSRegularExpression *time = [NSRegularExpression regularExpressionWithPattern:@"^(昨天 )?\\d{1,2}:\\d{2}$" options:0 error:nil];
    return [time firstMatchInString:trimmed options:0 range:NSMakeRange(0, trimmed.length)] != nil;
}

static void Emit(NSDictionary *value, FILE *stream) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    fprintf(stream, "%s\n", [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] UTF8String]);
}

static void Fail(NSString *code, NSString *detail) {
    Emit(@{@"ok": @NO, @"error": code, @"detail": detail ?: @""}, stderr);
    exit(2);
}

static NSDictionary *AXDiagnostic(AXUIElementRef root, CFStringRef attribute) {
    CFTypeRef value = NULL;
    AXError error = AXUIElementCopyAttributeValue(root, attribute, &value);
    NSUInteger count = value && CFGetTypeID(value) == CFArrayGetTypeID() ? CFArrayGetCount(value) : (value ? 1 : 0);
    if (value) CFRelease(value);
    return @{@"error": @(error), @"count": @(count)};
}

static NSArray *AXActions(AXUIElementRef element) {
    CFArrayRef actions = NULL;
    AXError error = AXUIElementCopyActionNames(element, &actions);
    if (error != kAXErrorSuccess || !actions) return @[];
    return CFBridgingRelease(actions);
}

static NSString *Option(NSArray<NSString *> *args, NSString *name) {
    NSUInteger index = [args indexOfObject:name];
    return index != NSNotFound && index + 1 < args.count ? args[index + 1] : nil;
}

static NSArray<NSString *> *Options(NSArray<NSString *> *args, NSString *name) {
    NSMutableArray<NSString *> *values = [NSMutableArray array];
    for (NSUInteger index = 0; index + 1 < args.count; index++) {
        if ([args[index] isEqualToString:name]) [values addObject:args[index + 1]];
    }
    return values;
}

static void PostKeyToPid(CGEventSourceRef source, pid_t pid, CGKeyCode key, CGEventFlags flags) {
    CGEventRef down = CGEventCreateKeyboardEvent(source, key, true);
    CGEventRef up = CGEventCreateKeyboardEvent(source, key, false);
    CGEventSetFlags(down, flags); CGEventSetFlags(up, flags);
    CGEventPostToPid(pid, down); CGEventPostToPid(pid, up);
    CFRelease(down); CFRelease(up);
}

static void PostKeyGlobal(CGEventSourceRef source, CGKeyCode key, CGEventFlags flags) {
    CGEventRef down = CGEventCreateKeyboardEvent(source, key, true);
    CGEventRef up = CGEventCreateKeyboardEvent(source, key, false);
    CGEventSetFlags(down, flags); CGEventSetFlags(up, flags);
    CGEventPost(kCGHIDEventTap, down); CGEventPost(kCGHIDEventTap, up);
    CFRelease(down); CFRelease(up);
}

static NSArray<NSPasteboardItem *> *CopyPasteboardItems(NSPasteboard *pasteboard) {
    NSMutableArray *copies = [NSMutableArray array];
    for (NSPasteboardItem *original in pasteboard.pasteboardItems ?: @[]) {
        NSPasteboardItem *copy = [NSPasteboardItem new];
        for (NSPasteboardType type in original.types) {
            NSData *data = [original dataForType:type];
            if (data) [copy setData:data forType:type];
        }
        [copies addObject:copy];
    }
    return copies;
}

static id ParentWithRole(AXUIElementRef element, CFStringRef wantedRole) {
    id current = (__bridge id)element;
    for (NSUInteger depth = 0; depth < 10; depth++) {
        id parent = AXAttr((__bridge AXUIElementRef)current, kAXParentAttribute);
        if (!parent) return nil;
        NSString *role = AXString((__bridge AXUIElementRef)parent, kAXRoleAttribute);
        if ([role isEqualToString:(__bridge NSString *)wantedRole]) return parent;
        current = parent;
    }
    return nil;
}

static BOOL ActivateWeChat(NSRunningApplication *app) {
    [app activateWithOptions:NSApplicationActivateAllWindows];
    for (NSUInteger attempt = 0; attempt < 10; attempt++) {
        if ([NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier isEqualToString:@"com.tencent.xinWeChat"]) return YES;
        usleep(50000);
    }
    return NO;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSDate *started = NSDate.date;
        NSMutableArray<NSString *> *args = [NSMutableArray array];
        for (int i = 1; i < argc; i++) [args addObject:[NSString stringWithUTF8String:argv[i]]];
        NSString *command = args.firstObject;
        if (!command) Fail(@"USAGE", @"status|snapshot|send");
        if ([command isEqualToString:@"match-name"]) {
            NSString *chat = Option(args, @"--chat") ?: @"";
            NSString *candidate = Option(args, @"--candidate") ?: @"";
            NSString *requestedNormalized = NormalizeChatName(chat);
            NSString *candidateNormalized = NormalizeChatName(candidate);
            Emit(@{ @"ok": @YES, @"matched": @(ChatNameMatches(candidate, chat)),
                    @"requested": requestedNormalized, @"candidate": candidateNormalized,
                    @"distance": @(ChatNameDistance(requestedNormalized, candidateNormalized)),
                    @"latencyMs": @(-started.timeIntervalSinceNow * 1000) }, stdout);
            return 0;
        }
        if (!AXIsProcessTrusted()) Fail(@"ACCESSIBILITY_PERMISSION_REQUIRED", @"Enable Accessibility for Codex or Terminal");
        NSArray<NSRunningApplication *> *apps = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.tencent.xinWeChat"];
        NSRunningApplication *app = apps.firstObject;
        if (!app) Fail(@"WECHAT_NOT_RUNNING", @"Open WeChat first");
        if ([command isEqualToString:@"debug"]) {
            NSMutableArray *diagnostics = [NSMutableArray array];
            for (NSRunningApplication *candidate in apps) {
                AXUIElementRef root = AXUIElementCreateApplication(candidate.processIdentifier);
                [diagnostics addObject:@{
                    @"pid": @(candidate.processIdentifier),
                    @"windows": AXDiagnostic(root, kAXWindowsAttribute),
                    @"children": AXDiagnostic(root, kAXChildrenAttribute),
                    @"focusedWindow": AXDiagnostic(root, kAXFocusedWindowAttribute),
                    @"role": AXDiagnostic(root, kAXRoleAttribute),
                }];
                CFRelease(root);
            }
            Emit(@{@"ok": @YES, @"trusted": @(AXIsProcessTrusted()), @"apps": diagnostics}, stdout);
            return 0;
        }
        if ([command isEqualToString:@"status"]) {
            Emit(@{@"ok": @YES, @"pid": @(app.processIdentifier), @"latencyMs": @(-started.timeIntervalSinceNow * 1000)}, stdout);
            return 0;
        }
        if ([command isEqualToString:@"activate"]) {
            if (!ActivateWeChat(app)) Fail(@"WECHAT_FOCUS_FAILED", @"macOS did not bring WeChat to the foreground");
            Emit(@{@"ok": @YES, @"pid": @(app.processIdentifier),
                   @"frontmost": @YES, @"latencyMs": @(-started.timeIntervalSinceNow * 1000)}, stdout);
            return 0;
        }

        if ([command isEqualToString:@"search"] && [args containsObject:@"--activate"] && !ActivateWeChat(app)) {
            Fail(@"WECHAT_FOCUS_FAILED", @"macOS did not bring WeChat to the foreground");
        }

        BOOL inboxMode = [command isEqualToString:@"inbox"];
        NSArray<NSString *> *allowedChats = Options(args, @"--allow");
        if (inboxMode && !allowedChats.count) Fail(@"ALLOWLIST_REQUIRED", @"Pass at least one --allow chat title");
        NSString *chat = Option(args, @"--chat") ?: @"";
        if (!inboxMode && !chat.length) Fail(@"CHAT_REQUIRED", @"Pass the requested chat title");
        NSInteger limit = MAX(1, MIN(20, [Option(args, @"--limit") ?: @"8" integerValue]));
        BOOL fastScan = [command isEqualToString:@"search"] || [command isEqualToString:@"select"] ||
                        [command isEqualToString:@"send"] || [command isEqualToString:@"inspect-fast"] || inboxMode;
        NSInteger pruneMode = fastScan ? 1 : ([command isEqualToString:@"snapshot"] ? 2 : 0);
        NSArray<NSDictionary *> *nodes = nil;
        NSDictionary *window = nil;
        for (NSRunningApplication *candidate in apps) {
            AXUIElementRef root = AXUIElementCreateApplication(candidate.processIdentifier);
            NSArray *windowElements = AXAttr(root, kAXWindowsAttribute);
            NSMutableArray<NSDictionary *> *candidateNodes = [NSMutableArray array];
            if ([windowElements isKindOfClass:NSArray.class]) {
                for (id windowElement in windowElements) {
                    CGFloat splitX = NSMidX(AXFrame((__bridge AXUIElementRef)windowElement));
                    [candidateNodes addObjectsFromArray:WalkMode((__bridge AXUIElementRef)windowElement, 1200 - candidateNodes.count, pruneMode, splitX)];
                    if (candidateNodes.count >= 1200) break;
                }
            }
            if (!candidateNodes.count) {
                id focusedWindow = AXAttr(root, kAXFocusedWindowAttribute);
                if (focusedWindow) {
                    CGFloat splitX = NSMidX(AXFrame((__bridge AXUIElementRef)focusedWindow));
                    [candidateNodes addObjectsFromArray:WalkMode((__bridge AXUIElementRef)focusedWindow, 1200, pruneMode, splitX)];
                }
            }
            if (!candidateNodes.count) [candidateNodes addObjectsFromArray:WalkMode(root, 1200, pruneMode, 0)];
            CFRelease(root);
            for (NSDictionary *node in candidateNodes) {
                if ([node[@"role"] isEqualToString:(__bridge NSString *)kAXWindowRole] && !NSEqualRects([node[@"frame"] rectValue], NSZeroRect)) {
                    app = candidate;
                    nodes = candidateNodes;
                    window = node;
                    break;
                }
            }
            if (window) break;
        }
        if (!window) Fail(@"WECHAT_WINDOW_NOT_FOUND", @"Open the main chat window");
        NSRect windowFrame = [window[@"frame"] rectValue];
        BOOL (^rightPane)(NSDictionary *) = ^BOOL(NSDictionary *node) {
            NSRect frame = [node[@"frame"] rectValue];
            return !NSEqualRects(frame, NSZeroRect) && NSMidX(frame) > NSMidX(windowFrame) && NSIntersectsRect(frame, windowFrame);
        };

        BOOL selectedMatched = NO;
        BOOL headerMatched = NO;
        NSDictionary *input = nil;
        NSMutableOrderedSet<NSString *> *messages = [NSMutableOrderedSet orderedSet];
        NSMutableArray *inspectSelected = [NSMutableArray array];
        NSMutableArray *inspectHeaders = [NSMutableArray array];
        NSMutableArray *inspectInputs = [NSMutableArray array];
        NSMutableArray *inspectAllFields = [NSMutableArray array];
        NSMutableArray *inspectText = [NSMutableArray array];
        NSMutableArray *inspectRight = [NSMutableArray array];
        NSMutableArray *inboxEntries = [NSMutableArray array];
        NSMutableSet *inboxSeen = [NSMutableSet set];
        NSDictionary *targetRow = nil;
        NSUInteger targetRowMatches = 0;
        NSDictionary *searchField = nil;
        for (NSDictionary *node in nodes) {
            NSString *role = node[@"role"];
            NSArray<NSString *> *strings = node[@"strings"];
            NSRect nodeFrame = [node[@"frame"] rectValue];
            if ([role isEqualToString:(__bridge NSString *)kAXTextFieldRole] &&
                !NSEqualRects(nodeFrame, NSZeroRect) && NSMidX(nodeFrame) < NSMidX(windowFrame) &&
                NSMinY(nodeFrame) < NSMinY(windowFrame) + 140 &&
                (!searchField || (![searchField[@"settable"] boolValue] && [node[@"settable"] boolValue]))) searchField = node;
            if (([role isEqualToString:(__bridge NSString *)kAXTextAreaRole] ||
                 [role isEqualToString:(__bridge NSString *)kAXTextFieldRole]) && inspectAllFields.count < 30) {
                NSRect fieldFrame = [node[@"frame"] rectValue];
                [inspectAllFields addObject:@{@"role": role, @"strings": strings,
                    @"settable": node[@"settable"], @"x": @(fieldFrame.origin.x), @"y": @(fieldFrame.origin.y),
                    @"w": @(fieldFrame.size.width), @"h": @(fieldFrame.size.height)}];
            }
            BOOL rowOrCell = [role isEqualToString:(__bridge NSString *)kAXRowRole] ||
                             [role isEqualToString:(__bridge NSString *)kAXCellRole];
            BOOL visibleLeftResult = rowOrCell && !NSEqualRects(nodeFrame, NSZeroRect) &&
                NSIntersectsRect(nodeFrame, windowFrame) && NSMidX(nodeFrame) < NSMidX(windowFrame) &&
                NSMidY(nodeFrame) >= NSMinY(windowFrame) && NSMidY(nodeFrame) <= NSMaxY(windowFrame);
            if (visibleLeftResult) {
                NSArray<NSString *> *candidateStrings = SubtreeStrings((__bridge AXUIElementRef)node[@"element"]);
                if (inboxMode && [role isEqualToString:(__bridge NSString *)kAXRowRole] && inboxEntries.count < limit) {
                    NSDictionary *entry = InboxEntry(candidateStrings, [node[@"selected"] boolValue]);
                    NSString *title = entry[@"chat"];
                    NSUInteger allowMatches = 0;
                    for (NSString *allowed in allowedChats) if (ChatNameMatches(title, allowed)) allowMatches += 1;
                    NSString *dedupe = title.length ? [NSString stringWithFormat:@"%@:%@", NormalizeChatName(title), entry[@"signature"] ?: @""] : @"";
                    if (entry && allowMatches == 1 && ![inboxSeen containsObject:dedupe]) {
                        [inboxEntries addObject:entry];
                        [inboxSeen addObject:dedupe];
                    }
                }
                for (NSString *value in candidateStrings) {
                    if (RowTitleMatches(value, chat)) {
                        if (!targetRow) {
                            targetRow = node;
                            targetRowMatches = 1;
                        } else {
                            NSRect existingFrame = [targetRow[@"frame"] rectValue];
                            if (!NSEqualRects(existingFrame, nodeFrame)) targetRowMatches += 1;
                        }
                        break;
                    }
                }
            }
            if (strings.count && inspectText.count < 120) {
                NSRect inspectFrame = [node[@"frame"] rectValue];
                [inspectText addObject:@{@"role": role, @"strings": strings,
                    @"x": @(inspectFrame.origin.x), @"y": @(inspectFrame.origin.y),
                    @"w": @(inspectFrame.size.width), @"h": @(inspectFrame.size.height)}];
            }
            if ([node[@"selected"] boolValue] && ([role isEqualToString:(__bridge NSString *)kAXRowRole] || [role isEqualToString:(__bridge NSString *)kAXCellRole])) {
                NSArray *subtree = SubtreeStrings((__bridge AXUIElementRef)node[@"element"]);
                if (inspectSelected.count < 10) [inspectSelected addObject:subtree];
                for (NSString *value in subtree) {
                    if (RowTitleMatches(value, chat)) selectedMatched = YES;
                }
            }
            if (rightPane(node) && [role isEqualToString:(__bridge NSString *)kAXStaticTextRole]) {
                if (inspectHeaders.count < 20 && strings.count) [inspectHeaders addObject:strings];
                for (NSString *value in strings) if (ChatNameMatches(value, chat)) headerMatched = YES;
            }
            NSRect frame = [node[@"frame"] rectValue];
            if (rightPane(node) && [node[@"settable"] boolValue] &&
                ([role isEqualToString:(__bridge NSString *)kAXTextAreaRole] || [role isEqualToString:(__bridge NSString *)kAXTextFieldRole]) && NSMidY(frame) > NSMidY(windowFrame)) {
                if (inspectInputs.count < 10) [inspectInputs addObject:@{@"role": role, @"strings": strings}];
                for (NSString *value in strings) if (ChatNameMatches(value, chat)) headerMatched = YES;
                if (!input || NSMidY(frame) > NSMidY([input[@"frame"] rectValue])) input = node;
            }
            BOOL isInputRole = [role isEqualToString:(__bridge NSString *)kAXTextAreaRole] || [role isEqualToString:(__bridge NSString *)kAXTextFieldRole];
            if (rightPane(node) && !isInputRole) for (NSString *value in strings) {
                if (!IsMessageNoise(value, chat)) {
                    [messages addObject:[value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet]];
                    if (inspectRight.count < 40) [inspectRight addObject:@{@"role": role, @"value": value}];
                }
            }
        }
        if (inboxMode) {
            NSMutableArray<NSString *> *parts = [NSMutableArray array];
            for (NSDictionary *entry in inboxEntries) [parts addObject:[NSString stringWithFormat:@"%@:%@", entry[@"chat"], entry[@"signature"]]];
            Emit(@{ @"ok": @YES, @"chats": inboxEntries, @"signature": FNV1a([parts componentsJoinedByString:@"\n"]),
                    @"matchedCount": @(inboxEntries.count), @"scanMs": @(-started.timeIntervalSinceNow * 1000) }, stdout);
            return 0;
        }
        if ([command isEqualToString:@"search"]) {
            if (!searchField) Fail(@"WECHAT_SEARCH_FIELD_NOT_FOUND", chat);
            AXUIElementRef fieldElement = (__bridge AXUIElementRef)searchField[@"element"];
            NSRect fieldFrame = [searchField[@"frame"] rectValue];
            CGPoint clickPoint = CGPointMake(NSMidX(fieldFrame), NSMidY(fieldFrame));
            BOOL globalKeys = [args containsObject:@"--global-keys"];
            BOOL noConfirm = [args containsObject:@"--no-confirm"];
            BOOL initialWritableSearch = [searchField[@"settable"] boolValue];
            if (globalKeys && ![NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier isEqualToString:@"com.tencent.xinWeChat"]) {
                Fail(@"WECHAT_NOT_FRONTMOST", @"Focus WeChat before global search keys");
            }
            if (globalKeys) {
                if (!initialWritableSearch) {
                    CGEventRef mouseDown = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, clickPoint, kCGMouseButtonLeft);
                    CGEventRef mouseUp = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, clickPoint, kCGMouseButtonLeft);
                    CGEventPost(kCGHIDEventTap, mouseDown);
                    CGEventPost(kCGHIDEventTap, mouseUp);
                    CFRelease(mouseDown);
                    CFRelease(mouseUp);
                }
            } else {
                CGEventRef mouseDown = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, clickPoint, kCGMouseButtonLeft);
                CGEventRef mouseUp = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, clickPoint, kCGMouseButtonLeft);
                CGEventPostToPid(app.processIdentifier, mouseDown);
                CGEventPostToPid(app.processIdentifier, mouseUp);
                CFRelease(mouseDown);
                CFRelease(mouseUp);
            }
            usleep(180000);
            if (globalKeys) {
                NSArray *refreshed = WalkMode((__bridge AXUIElementRef)window[@"element"], 500, 1, NSMidX(windowFrame));
                BOOL foundWritableSearch = initialWritableSearch;
                for (NSDictionary *candidate in refreshed) {
                    NSString *candidateRole = candidate[@"role"];
                    NSRect candidateFrame = [candidate[@"frame"] rectValue];
                    if ([candidateRole isEqualToString:(__bridge NSString *)kAXTextFieldRole] &&
                        [candidate[@"settable"] boolValue] && NSMidX(candidateFrame) < NSMidX(windowFrame) &&
                        NSMinY(candidateFrame) < NSMinY(windowFrame) + 140) {
                        fieldElement = (__bridge AXUIElementRef)candidate[@"element"];
                        fieldFrame = candidateFrame;
                        clickPoint = CGPointMake(NSMidX(fieldFrame), NSMidY(fieldFrame));
                        foundWritableSearch = YES;
                        break;
                    }
                }
                if (!foundWritableSearch) Fail(@"WECHAT_SEARCH_INPUT_NOT_READY", chat);
            }
            AXError focusError = AXUIElementSetAttributeValue(fieldElement, kAXFocusedAttribute, kCFBooleanTrue);
            if (globalKeys) {
                if (focusError != kAXErrorSuccess || !AXBool(fieldElement, kAXFocusedAttribute)) {
                    CGEventRef mouseDown = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, clickPoint, kCGMouseButtonLeft);
                    CGEventRef mouseUp = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, clickPoint, kCGMouseButtonLeft);
                    CGEventPost(kCGHIDEventTap, mouseDown);
                    CGEventPost(kCGHIDEventTap, mouseUp);
                    CFRelease(mouseDown);
                    CFRelease(mouseUp);
                    usleep(100000);
                }
                if (!AXBool(fieldElement, kAXFocusedAttribute)) Fail(@"WECHAT_SEARCH_INPUT_NOT_FOCUSED", chat);
                NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
                NSArray *savedItems = CopyPasteboardItems(pasteboard);
                [pasteboard clearContents];
                [pasteboard setString:chat forType:NSPasteboardTypeString];
                NSInteger bridgePasteChange = pasteboard.changeCount;
                CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateCombinedSessionState);
                PostKeyGlobal(source, 0, kCGEventFlagMaskCommand);
                usleep(40000);
                PostKeyGlobal(source, 9, kCGEventFlagMaskCommand);
                CFRelease(source);
                usleep(260000);
                if (!noConfirm) {
                    CGEventSourceRef confirmSource = CGEventSourceCreate(kCGEventSourceStateCombinedSessionState);
                    PostKeyGlobal(confirmSource, 36, 0);
                    CFRelease(confirmSource);
                }
                usleep(300000);
                BOOL clipboardRestored = NO;
                if (pasteboard.changeCount == bridgePasteChange) {
                    [pasteboard clearContents];
                    if (savedItems.count) [pasteboard writeObjects:savedItems];
                    clipboardRestored = YES;
                }
                NSArray *query = @[];
                NSArray *afterPaste = WalkMode((__bridge AXUIElementRef)window[@"element"], 500, 1, NSMidX(windowFrame));
                for (NSDictionary *candidate in afterPaste) {
                    NSString *candidateRole = candidate[@"role"];
                    NSRect candidateFrame = [candidate[@"frame"] rectValue];
                    if ([candidateRole isEqualToString:(__bridge NSString *)kAXTextFieldRole] &&
                        [candidate[@"settable"] boolValue] && NSMidX(candidateFrame) < NSMidX(windowFrame) &&
                        NSMinY(candidateFrame) < NSMinY(windowFrame) + 140) {
                        query = candidate[@"strings"];
                        break;
                    }
                }
                Emit(@{@"ok": @YES, @"chat": chat, @"searchAttempted": @YES,
                       @"globalKeys": @YES, @"focusError": @(focusError),
                       @"query": query, @"queryVerified": @([query containsObject:chat]),
                       @"clipboardRestored": @(clipboardRestored),
                       @"x": @(clickPoint.x), @"y": @(clickPoint.y),
                       @"latencyMs": @(-started.timeIntervalSinceNow * 1000)}, stdout);
                return 0;
            }
            AXUIElementSetAttributeValue(fieldElement, kAXValueAttribute, (__bridge CFTypeRef)@"");
            usleep(80000);
            AXError valueError = AXUIElementSetAttributeValue(fieldElement, kAXValueAttribute, (__bridge CFTypeRef)chat);
            usleep(160000);
            Emit(@{@"ok": @YES, @"chat": chat, @"searchAttempted": @YES,
                   @"focusError": @(focusError), @"valueError": @(valueError),
                   @"x": @(clickPoint.x), @"y": @(clickPoint.y),
                   @"latencyMs": @(-started.timeIntervalSinceNow * 1000)}, stdout);
            return 0;
        }
        if ([command isEqualToString:@"select"]) {
            BOOL globalClick = [args containsObject:@"--global-click"];
            if (selectedMatched && headerMatched) {
                Emit(@{@"ok": @YES, @"chat": chat, @"alreadySelected": @YES,
                       @"latencyMs": @(-started.timeIntervalSinceNow * 1000)}, stdout);
                return 0;
            }
            if (!targetRow) Fail(@"WECHAT_CHAT_NOT_VISIBLE", [@"Chat row is not currently loaded: " stringByAppendingString:chat]);
            if (targetRowMatches > 1) Fail(@"WECHAT_AMBIGUOUS_CHAT", [@"Multiple exact-title rows: " stringByAppendingString:chat]);
            AXUIElementRef rowElement = (__bridge AXUIElementRef)targetRow[@"element"];
            AXError focusError = AXUIElementSetAttributeValue(rowElement, kAXFocusedAttribute, kCFBooleanTrue);
            AXError selectedError = AXUIElementSetAttributeValue(rowElement, kAXSelectedAttribute, kCFBooleanTrue);
            id tableElement = ParentWithRole(rowElement, kAXTableRole);
            AXError selectedRowsError = tableElement ? AXUIElementSetAttributeValue(
                (__bridge AXUIElementRef)tableElement, kAXSelectedRowsAttribute, (__bridge CFArrayRef)@[targetRow[@"element"]]
            ) : kAXErrorNoValue;
            AXError pressError = AXUIElementPerformAction(rowElement, kAXPressAction);
            NSRect rowFrame = [targetRow[@"frame"] rectValue];
            if (globalClick && (!NSIntersectsRect(rowFrame, windowFrame) || NSMidY(rowFrame) < NSMinY(windowFrame) || NSMidY(rowFrame) > NSMaxY(windowFrame))) {
                Fail(@"WECHAT_SEARCH_RESULT_NOT_VISIBLE", chat);
            }
            CGPoint clickPoint = CGPointMake(NSMidX(rowFrame), NSMidY(rowFrame));
            CGEventRef mouseMove = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, clickPoint, kCGMouseButtonLeft);
            CGEventRef mouseDown = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, clickPoint, kCGMouseButtonLeft);
            CGEventRef mouseUp = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, clickPoint, kCGMouseButtonLeft);
            if (globalClick) {
                CGEventPost(kCGHIDEventTap, mouseMove);
                CGEventPost(kCGHIDEventTap, mouseDown);
                CGEventPost(kCGHIDEventTap, mouseUp);
            } else {
                CGEventPostToPid(app.processIdentifier, mouseMove);
                CGEventPostToPid(app.processIdentifier, mouseDown);
                CGEventPostToPid(app.processIdentifier, mouseUp);
            }
            CFRelease(mouseMove);
            CFRelease(mouseDown);
            CFRelease(mouseUp);
            Emit(@{@"ok": @YES, @"chat": chat, @"selectionAttempted": @YES,
                   @"focusError": @(focusError), @"selectedError": @(selectedError),
                   @"selectedRowsError": @(selectedRowsError), @"axPressError": @(pressError),
                   @"rowActions": AXActions(rowElement),
                   @"tableActions": tableElement ? AXActions((__bridge AXUIElementRef)tableElement) : @[],
                   @"globalClick": @(globalClick),
                   @"x": @(clickPoint.x), @"y": @(clickPoint.y),
                   @"latencyMs": @(-started.timeIntervalSinceNow * 1000)}, stdout);
            return 0;
        }
        if ([command isEqualToString:@"inspect"] || [command isEqualToString:@"inspect-fast"]) {
            Emit(@{@"ok": @YES, @"chat": chat, @"scanMs": @(-started.timeIntervalSinceNow * 1000),
                   @"selected": inspectSelected, @"rightPaneStaticText": inspectHeaders, @"inputs": inspectInputs,
                   @"allFields": inspectAllFields,
                   @"textNodes": inspectText, @"rightPaneText": inspectRight,
                   @"selectedMatched": @(selectedMatched), @"headerMatched": @(headerMatched), @"nodeCount": @(nodes.count)}, stdout);
            return 0;
        }
        if (!selectedMatched || !headerMatched) Fail(@"WECHAT_TARGET_MISMATCH", [@"Select the verified chat: " stringByAppendingString:chat]);
        if (!input) Fail(@"WECHAT_INPUT_NOT_FOUND", chat);
        NSArray *allMessages = messages.array;
        NSArray *recent = allMessages.count > limit ? [allMessages subarrayWithRange:NSMakeRange(allMessages.count - limit, limit)] : allMessages;
        NSString *signature = FNV1a([recent componentsJoinedByString:@"\n"]);
        if ([command isEqualToString:@"snapshot"]) {
            Emit(@{@"ok": @YES, @"chat": chat, @"messages": recent, @"signature": signature,
                   @"inputReady": @YES, @"selectedChatMatched": @YES, @"headerMatched": @YES,
                   @"scanMs": @(-started.timeIntervalSinceNow * 1000)}, stdout);
            return 0;
        }
        if ([command isEqualToString:@"send"]) {
            NSString *text = Option(args, @"--text");
            if (![text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length) Fail(@"TEXT_REQUIRED", @"Pass non-empty --text");
            AXUIElementRef inputElement = (__bridge AXUIElementRef)input[@"element"];
            if (AXUIElementSetAttributeValue(inputElement, kAXFocusedAttribute, kCFBooleanTrue) != kAXErrorSuccess ||
                AXUIElementSetAttributeValue(inputElement, kAXValueAttribute, (__bridge CFTypeRef)text) != kAXErrorSuccess) Fail(@"WECHAT_INPUT_WRITE_FAILED", chat);
            if (!AXBool(inputElement, kAXFocusedAttribute)) Fail(@"WECHAT_INPUT_NOT_FOCUSED", chat);
            CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateCombinedSessionState);
            NSString *shortcut = @"AXConfirm";
            AXUIElementPerformAction(inputElement, kAXConfirmAction);
            usleep(160000);
            NSString *remaining = AXString(inputElement, kAXValueAttribute) ?: @"";
            if ([remaining stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length) {
                shortcut = @"Return";
                PostKeyToPid(source, app.processIdentifier, 36, 0);
                usleep(160000);
                remaining = AXString(inputElement, kAXValueAttribute) ?: @"";
            }
            if ([remaining stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length) {
                shortcut = @"Command+Return";
                PostKeyToPid(source, app.processIdentifier, 36, kCGEventFlagMaskCommand);
                usleep(160000);
                remaining = AXString(inputElement, kAXValueAttribute) ?: @"";
            }
            if ([remaining stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length) {
                shortcut = @"Control+Return";
                PostKeyToPid(source, app.processIdentifier, 36, kCGEventFlagMaskControl);
                usleep(160000);
                remaining = AXString(inputElement, kAXValueAttribute) ?: @"";
            }
            CFRelease(source);
            if ([remaining stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length) {
                Fail(@"WECHAT_SEND_SHORTCUT_UNKNOWN", @"Message remains in the input box; nothing was reported as sent");
            }
            Emit(@{@"ok": @YES, @"chat": chat, @"sentChars": @(text.length), @"signature": signature,
                   @"shortcut": shortcut, @"inputCleared": @YES,
                   @"latencyMs": @(-started.timeIntervalSinceNow * 1000)}, stdout);
            return 0;
        }
        Fail(@"UNKNOWN_COMMAND", command);
    }
}
